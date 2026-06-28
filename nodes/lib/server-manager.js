"use strict";

const os = require("os");
const path = require("path");
const {
    OPCUAServer,
    OPCUACertificateManager,
    MessageSecurityMode,
    SecurityPolicy,
    Variant,
    DataType,
    StatusCodes,
    nodesets
} = require("node-opcua");

/**
 * Wraps a node-opcua OPCUAServer and exposes a simple variable model so a
 * Node-RED node can:
 *   - publish values outward (setValue) for clients to read / subscribe, and
 *   - react to client writes via the onClientWrite callback.
 *
 * Each variable is backed by an entry in `this.vars`:
 *   { dataType: DataType, value: any, uaVariable: UAVariable }
 * The UA variable uses get/set closures over that entry, so node-opcua's
 * sampling picks up Node-RED-driven changes for subscriptions automatically.
 *
 * Standalone (no Node-RED dependency) so it can be unit-tested in isolation.
 */
class ServerManager {
    /**
     * @param {object} config
     * @param {number} [config.port]
     * @param {string} [config.resourcePath]
     * @param {string} [config.serverName]
     * @param {boolean} [config.allowAnonymous]
     * @param {string} [config.username] enables username/password auth when set
     * @param {string} [config.password]
     * @param {string[]} [config.securityModes] subset of "None"|"Sign"|"SignAndEncrypt"
     * @param {string} [config.pkiFolder] where the server certificate / trust lists live
     * @param {boolean} [config.acceptUntrusted] dev-only: trust unknown client certs
     * @param {Array<{name:string,dataType:string,value:any}>} [config.variables]
     * @param {string} [config.folderName] address-space object that holds the vars
     * @param {(name:string, value:any, nodeId:string) => void} [config.onClientWrite]
     */
    constructor(config) {
        this.config = config || {};
        this.port = this.config.port || 4840;
        this.resourcePath = this.config.resourcePath || "/UA/NodeRED";
        this.serverName = this.config.serverName || "Node-RED OPC-UA Server";
        this.folderName = this.config.folderName || "NodeRED";
        this.allowAnonymous = this.config.allowAnonymous !== false;
        this.username = this.config.username || undefined;
        this.password = this.config.password;
        this.securityModeNames = (Array.isArray(this.config.securityModes) && this.config.securityModes.length)
            ? this.config.securityModes
            : ["None"];
        this.pkiFolder = this.config.pkiFolder || path.join(os.tmpdir(), "node-red-opcua-pki");
        this.acceptUntrusted = this.config.acceptUntrusted === true;
        this.onClientWrite = this.config.onClientWrite || function () {};

        this.server = null;
        this.namespace = null;
        this.folder = null;
        this.state = "stopped";
        this.lastError = null;
        this.endpointUrl = null;

        /** @type {Object<string,{dataType:number,value:any,uaVariable:any}>} */
        this.vars = {};
        this.pendingValues = {};

        this.listeners = [];
    }

    /** @returns {number} DataType enum value (defaults to Double) */
    mapDataType(name) {
        const dt = DataType[name];
        return dt === undefined ? DataType.Double : dt;
    }

    /** @returns {boolean} whether any secure (Sign/SignAndEncrypt) mode is offered */
    hasSecureMode() {
        return this.securityModeNames.includes("Sign") ||
            this.securityModeNames.includes("SignAndEncrypt");
    }

    /**
     * Translate the configured mode names into node-opcua security arrays.
     * @private
     * @returns {{securityModes:number[], securityPolicies:string[]}}
     */
    _buildSecurity() {
        const modes = [];
        const policies = new Set();
        if (this.securityModeNames.includes("None")) {
            modes.push(MessageSecurityMode.None);
            policies.add(SecurityPolicy.None);
        }
        if (this.securityModeNames.includes("Sign")) {
            modes.push(MessageSecurityMode.Sign);
            policies.add(SecurityPolicy.Basic256Sha256);
        }
        if (this.securityModeNames.includes("SignAndEncrypt")) {
            modes.push(MessageSecurityMode.SignAndEncrypt);
            policies.add(SecurityPolicy.Basic256Sha256);
        }
        if (modes.length === 0) {
            modes.push(MessageSecurityMode.None);
            policies.add(SecurityPolicy.None);
        }
        // Username/password tokens must be encrypted with the server certificate.
        // Offer Basic256Sha256 as a user-token policy so credentials are protected
        // even when the channel itself is None.
        if (this.username) {
            policies.add(SecurityPolicy.Basic256Sha256);
        }
        return { securityModes: modes, securityPolicies: [...policies] };
    }

    /**
     * Best-practice advisories about the current server security configuration.
     * @returns {string[]}
     */
    serverSecurityWarnings() {
        const warnings = [];
        const secure = this.hasSecureMode();
        if (this.securityModeNames.includes("None")) {
            warnings.push("Server exposes an unsecured 'None' endpoint. For production, " +
                "disable None and require Sign/SignAndEncrypt.");
        }
        if (this.allowAnonymous && secure) {
            warnings.push("Server allows anonymous access. Require username/password for production.");
        }
        if (this.username && !secure) {
            warnings.push("Server accepts credentials over an unencrypted channel (None). " +
                "Offer SignAndEncrypt so credentials are protected.");
        }
        if (secure && this.acceptUntrusted) {
            warnings.push("Server is accepting untrusted client certificates (development only). " +
                "Disable it and trust client certificates explicitly for production.");
        }
        if (!this.allowAnonymous && !this.username) {
            warnings.push("Server has anonymous access disabled and no username configured — " +
                "no client will be able to authenticate.");
        }
        return warnings;
    }

    /**
     * Start the server and create the configured variables.
     * @returns {Promise<void>}
     */
    async start() {
        if (this.state === "running" || this.state === "starting") return;
        this._setState("starting");
        try {
            const { securityModes, securityPolicies } = this._buildSecurity();
            const options = {
                port: this.port,
                resourcePath: this.resourcePath,
                nodeset_filename: [nodesets.standard],
                allowAnonymous: this.allowAnonymous,
                securityModes,
                securityPolicies,
                buildInfo: {
                    productName: this.serverName,
                    buildNumber: "1",
                    buildDate: new Date()
                }
            };

            // Username/password authentication (single user).
            if (this.username) {
                const expectedUser = this.username;
                const expectedPass = this.password;
                options.userManager = {
                    isValidUser: (userName, password) =>
                        userName === expectedUser && password === expectedPass
                };
            }

            // Secure endpoints — and encrypted username tokens — need a server
            // certificate + a client-cert trust store.
            if (this.hasSecureMode() || this.username) {
                const scm = new OPCUACertificateManager({
                    rootFolder: path.join(this.pkiFolder, "server"),
                    automaticallyAcceptUnknownCertificate: this.acceptUntrusted
                });
                await scm.initialize();
                options.serverCertificateManager = scm;
            }

            this.server = new OPCUAServer(options);

            await this.server.initialize();

            const addressSpace = this.server.engine.addressSpace;
            this.namespace = addressSpace.getOwnNamespace();
            this.folder = this.namespace.addObject({
                organizedBy: addressSpace.rootFolder.objects,
                browseName: this.folderName
            });

            for (const v of (this.config.variables || [])) {
                this._createVariable(v.name, v.dataType, this._coerce(v.dataType, v.value));
            }

            for (const [name, pending] of Object.entries(this.pendingValues)) {
                this._createVariable(name, pending.dataTypeName || "Double", pending.value);
            }
            this.pendingValues = {};

            await this.server.start();
            this.endpointUrl = this.server.getEndpointUrl();
            this._setState("running");
        } catch (err) {
            this.lastError = err;
            this._setState("error", err);
            throw err;
        }
    }

    /**
     * Create (or no-op if exists) a served variable.
     * @private
     */
    _createVariable(name, dataTypeName, initialValue) {
        if (this.vars[name]) return this.vars[name];

        const dataType = this.mapDataType(dataTypeName);
        const entry = { dataType, value: initialValue, uaVariable: null };
        this.vars[name] = entry;

        entry.uaVariable = this.namespace.addVariable({
            componentOf: this.folder,
            nodeId: "ns=1;s=" + name,
            browseName: name,
            dataType: dataTypeName || "Double",
            minimumSamplingInterval: 100,
            value: {
                get: () => new Variant({ dataType: entry.dataType, value: entry.value }),
                set: (variant) => {
                    entry.value = variant.value;
                    try {
                        this.onClientWrite(name, variant.value, "ns=1;s=" + name);
                    } catch (_e) { /* never break the write path */ }
                    return StatusCodes.Good;
                }
            }
        });
        return entry;
    }

    /** @private best-effort coercion of a configured string value to its datatype */
    _coerce(dataTypeName, value) {
        const numeric = ["SByte", "Byte", "Int16", "UInt16", "Int32", "UInt32", "Float", "Double"];
        if (numeric.includes(dataTypeName)) {
            const n = parseFloat(value);
            return isNaN(n) ? 0 : n;
        }
        if (dataTypeName === "Boolean") {
            return value === true || value === "true" || value === 1 || value === "1";
        }
        return value === undefined || value === null ? "" : value;
    }

    /**
     * Publish a value outward (Node-RED -> served). Creates the variable on the
     * fly (default Double) if it does not exist yet.
     * @param {string} name
     * @param {any} value
     * @param {string} [dataTypeName] used only when creating a new variable
     */
    setValue(name, value, dataTypeName) {
        const entry = this.vars[name];
        if (!entry) {
            if (!this.namespace || !this.folder) {
                this.pendingValues[name] = { value, dataTypeName: dataTypeName || "Double" };
                return;
            }
            this._createVariable(name, dataTypeName || "Double", value);
            return;
        }
        entry.value = value;
    }

    /** @returns {any} current value or undefined */
    getValue(name) {
        return this.vars[name] ? this.vars[name].value : undefined;
    }

    /** @returns {string[]} variable names currently served */
    listVariables() {
        return Object.keys({ ...this.pendingValues, ...this.vars });
    }

    /** @returns {object} lightweight runtime diagnostics */
    diagnostics() {
        return {
            state: this.state,
            port: this.port,
            endpointUrl: this.endpointUrl,
            lastError: this.lastError ? this.lastError.message : null,
            variableCount: Object.keys(this.vars).length,
            pendingValueCount: Object.keys(this.pendingValues).length
        };
    }

    /**
     * Stop the server and release the port.
     * @returns {Promise<void>}
     */
    async stop() {
        const server = this.server;
        this.server = null;
        this.namespace = null;
        this.folder = null;
        this.vars = {};
        this.pendingValues = {};
        try {
            if (server) await server.shutdown();
            this._setState("stopped");
        } catch (err) {
            this.lastError = err;
            this._setState("error", err);
        }
    }

    /** Register a state listener: fn(state, info). */
    onState(listener) {
        this.listeners.push(listener);
    }

    /** @private */
    _setState(state, info) {
        this.state = state;
        for (const listener of this.listeners) {
            try { listener(state, info); } catch (_e) { /* ignore */ }
        }
    }
}

module.exports = { ServerManager };
