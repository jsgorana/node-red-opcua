"use strict";

const os = require("os");
const path = require("path");
const {
    OPCUAClient,
    OPCUACertificateManager,
    AttributeIds,
    ClientSubscription,
    MonitoringMode,
    MessageSecurityMode,
    SecurityPolicy,
    TimestampsToReturn,
    UserTokenType
} = require("node-opcua");

/** Security policies deprecated by the OPC Foundation — discouraged. */
const DEPRECATED_POLICIES = ["Basic128Rsa15", "Basic256"];

/**
 * Ref-counted OPC-UA connection manager.
 *
 * One instance is shared by every operation node attached to a single
 * `opcua-endpoint` config node, so they reuse one OPCUAClient + ClientSession.
 * Handles automatic reconnection and reports state changes to listeners.
 *
 * This module has no Node-RED dependency — it is a standalone library so it
 * can be unit-tested in isolation.
 */
class ConnectionManager {
    /**
     * @param {object} config
     * @param {string} config.endpointUrl    e.g. "opc.tcp://localhost:4840"
     * @param {string} [config.securityMode] "None" | "Sign" | "SignAndEncrypt"
     * @param {string} [config.securityPolicy] key of SecurityPolicy, e.g. "Basic256Sha256"
     * @param {string} [config.authType]     "anonymous" | "username"
     * @param {string} [config.username]
     * @param {string} [config.password]
     * @param {string} [config.applicationName]
     */
    constructor(config) {
        this.config = config || {};
        this.applicationName = this.config.applicationName || "node-red-opcua";

        // Max time a single operation (incl. waiting for a session) will block
        // before failing fast. 0 disables the timeout. The background client
        // keeps retrying regardless, so subscriptions still recover.
        const t = parseInt(this.config.timeout, 10);
        this.timeout = (Number.isFinite(t) && t >= 0) ? t : 10000;

        // PKI: where the client's application certificate and the trusted/rejected
        // server certificate lists live. Persisted so the client identity and
        // trust decisions survive restarts.
        this.pkiFolder = this.config.pkiFolder ||
            path.join(os.tmpdir(), "node-red-opcua-pki");

        // Secure by default: unknown server certificates are REJECTED (they land
        // in the PKI "rejected" folder to be trusted explicitly). Only set true
        // for development — it disables server-certificate validation.
        this.acceptUntrusted = this.config.acceptUntrusted === true;

        this._certManager = null;

        this.client = null;
        this.session = null;
        this.refCount = 0;
        this.state = "closed";
        this.lastError = null;
        this.listeners = [];

        /** @type {Promise<void>|null} in-flight connect promise for dedup */
        this._connecting = null;

        this._sharedSubscription = null;
        this._sharedSubscriptionStarting = null;
        this._sharedSubscriptionEpoch = 0;
    }

    /** @returns {object} node-opcua userIdentity token */
    buildUserIdentity() {
        if (this.config.authType === "username") {
            return {
                type: UserTokenType.UserName,
                userName: this.config.username,
                password: this.config.password
            };
        }
        return { type: UserTokenType.Anonymous };
    }

    /** @returns {number} MessageSecurityMode (defaults to None) */
    mapSecurityMode() {
        const mode = MessageSecurityMode[this.config.securityMode];
        return mode || MessageSecurityMode.None;
    }

    /** @returns {string} SecurityPolicy (defaults to None) */
    mapSecurityPolicy() {
        const policy = SecurityPolicy[this.config.securityPolicy];
        return policy || SecurityPolicy.None;
    }

    /**
     * Lazily create + initialize the client certificate manager. Server
     * certificates are validated against this store; unknown ones are rejected
     * unless `acceptUntrusted` is set (development only).
     * @private
     * @returns {Promise<OPCUACertificateManager>}
     */
    async _getCertificateManager() {
        if (this._certManager) return this._certManager;
        const mgr = new OPCUACertificateManager({
            rootFolder: this.pkiFolder,
            automaticallyAcceptUnknownCertificate: this.acceptUntrusted
        });
        await mgr.initialize();
        this._certManager = mgr;
        return mgr;
    }

    /**
     * Best-practice advisories about the current security configuration.
     * @returns {string[]}
     */
    securityWarnings() {
        const warnings = [];
        const policy = this.config.securityPolicy;
        const mode = this.config.securityMode;

        if (DEPRECATED_POLICIES.includes(policy)) {
            warnings.push("Security policy '" + policy + "' is deprecated by the OPC " +
                "Foundation; prefer Basic256Sha256, Aes128_Sha256_RsaOaep or Aes256_Sha256_RsaPss.");
        }
        if (this.config.authType === "username" && (!mode || mode === "None")) {
            warnings.push("Username/password is being used over an unencrypted channel " +
                "(SecurityMode None). The token is encrypted with the server certificate, " +
                "but SecurityMode SignAndEncrypt is recommended for credentials.");
        }
        if (mode && mode !== "None" && this.acceptUntrusted) {
            warnings.push("Accepting untrusted server certificates is insecure and intended " +
                "for development only. Disable it and trust the server certificate explicitly " +
                "for production.");
        }
        return warnings;
    }

    /**
     * Connect to the server and open a session. Idempotent: concurrent calls
     * share a single in-flight promise; a successful prior connect resolves
     * immediately.
     * @returns {Promise<void>}
     */
    async connect() {
        if (this.state === "connected" && this.session) {
            return;
        }
        if (this._connecting) {
            return this._connecting;
        }
        this._connecting = this._doConnect();
        try {
            await this._connecting;
        } finally {
            this._connecting = null;
        }
    }

    /** @private actual connect/session work */
    async _doConnect() {
        this._setState("connecting");
        try {
            if (!this.client) {
                const options = {
                    applicationName: this.applicationName,
                    clientName: this.config.endpointUrl,
                    endpointMustExist: false,
                    securityMode: this.mapSecurityMode(),
                    securityPolicy: this.mapSecurityPolicy(),
                    keepSessionAlive: true,
                    connectionStrategy: {
                        maxRetry: -1,
                        initialDelay: 1000,
                        maxDelay: 20000
                    }
                };

                // Only a secure channel needs certificates. Using a persisted,
                // validating certificate manager is what enforces server-cert trust.
                if (this.mapSecurityPolicy() !== SecurityPolicy.None) {
                    options.clientCertificateManager = await this._getCertificateManager();
                }

                this.client = OPCUAClient.create(options);
                this._wireClientEvents(this.client);
            }

            await this.client.connect(this.config.endpointUrl);
            this.session = await this.client.createSession(this.buildUserIdentity());
            this.lastError = null;
            this._setState("connected");
        } catch (err) {
            this.lastError = err;
            this._setState("error", err);
            throw err;
        }
    }

    /** @private wire auto-reconnect lifecycle events to state changes */
    _wireClientEvents(client) {
        client.on("connection_lost", () => {
            this._dropSharedSubscription();
            this._setState("reconnecting");
        });
        client.on("start_reconnection", () => {
            this._dropSharedSubscription();
            this._setState("reconnecting");
        });
        client.on("connection_reestablished", () => this._setState("connected"));
        // Surfaced for diagnostics; never throw inside handlers.
        client.on("backoff", (_retry, delay) => {
            const suffix = delay ? " (retrying in " + delay + "ms)" : "";
            this.lastError = new Error("OPC-UA server unreachable" + suffix);
            this._setState(this.session ? "reconnecting" : "error", this.lastError);
        });
        client.on("reconnection_attempt_has_failed", (err) => {
            this.lastError = err;
        });
    }

    /**
     * Ensure connected, then return the live session.
     * @returns {Promise<import("node-opcua").ClientSession>}
     */
    async getSession() {
        if (this.state === "connected" && this.session) {
            return this.session;
        }
        // The node-opcua client auto-reconnects internally and resumes the same
        // session. While that is happening, calling connect() again throws
        // ("invalid internal state = reconnecting"), so instead we wait for the
        // connection to come back. runWithTimeout() bounds how long we wait.
        if (this.client && (this.state === "reconnecting" || this._connecting)) {
            await this._waitUntilConnected();
            return this.session;
        }
        await this.connect();
        return this.session;
    }

    /**
     * Resolve once the connection reaches "connected"; reject if it is torn down
     * or the wait exceeds the configured timeout. Always removes its listener and
     * timer so it can never leak (the previous version leaked a listener on every
     * timed-out wait during a sustained outage).
     * @private
     * @returns {Promise<void>}
     */
    _waitUntilConnected() {
        if (this.state === "connected" && this.session) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            let unsubscribe;
            let timer;
            const cleanup = () => {
                if (unsubscribe) unsubscribe();
                if (timer) clearTimeout(timer);
            };
            unsubscribe = this.onState((state) => {
                if (state === "connected") {
                    cleanup();
                    resolve();
                } else if (state === "closed") {
                    cleanup();
                    reject(new Error("OPC-UA connection closed while waiting to reconnect"));
                }
            });
            if (this.timeout && this.timeout > 0) {
                timer = setTimeout(() => {
                    cleanup();
                    reject(new Error("Timed out waiting for OPC-UA reconnection after " +
                        this.timeout + "ms"));
                }, this.timeout);
            }
        });
    }

    /**
     * Run an operation with the configured fail-fast timeout. The operation is
     * supplied as a factory so it only starts when called. On timeout the
     * returned promise rejects, but the underlying client keeps reconnecting.
     * @param {() => Promise<any>} factory
     * @param {string} [label]
     * @returns {Promise<any>}
     */
    runWithTimeout(factory, label) {
        if (!this.timeout || this.timeout <= 0) {
            return factory();
        }
        let timer;
        const timeoutPromise = new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
                reject(new Error(
                    (label || "OPC-UA operation") + " timed out after " +
                    this.timeout + "ms (server unreachable?)"
                ));
            }, this.timeout);
        });
        return Promise.race([factory(), timeoutPromise]).finally(() => clearTimeout(timer));
    }

    /**
     * Add a monitored Value item to the endpoint's shared subscription.
     * @param {object} options
     * @param {string} options.nodeId
     * @param {number} options.samplingInterval
     * @param {number} options.publishingInterval used when creating the shared subscription
     * @param {number} [options.queueSize]
     * @param {import("node-opcua").DataChangeFilter} [options.filter]
     * @param {(dataValue:any) => void} options.onChanged
     * @param {(err:Error) => void} [options.onError]
     * @returns {Promise<{terminate: () => Promise<void>}>}
     */
    async monitorValue(options) {
        const subscription = await this._getSharedSubscription(options);
        const monitoringParameters = {
            samplingInterval: options.samplingInterval,
            discardOldest: true,
            queueSize: options.queueSize || 10
        };
        if (options.filter) {
            monitoringParameters.filter = options.filter;
        }

        const monitoredItem = await subscription.monitor(
            { nodeId: options.nodeId, attributeId: AttributeIds.Value },
            monitoringParameters,
            TimestampsToReturn.Both,
            MonitoringMode.Reporting
        );
        monitoredItem.on("changed", options.onChanged);
        if (options.onError) {
            monitoredItem.on("err", options.onError);
        }

        return {
            terminate: async () => {
                monitoredItem.removeListener("changed", options.onChanged);
                if (options.onError) {
                    monitoredItem.removeListener("err", options.onError);
                }
                try { await monitoredItem.terminate(); } catch (_e) { /* ignore */ }
            }
        };
    }

    /** @private */
    async _getSharedSubscription(options) {
        if (this._sharedSubscription) return this._sharedSubscription;
        if (this._sharedSubscriptionStarting) return this._sharedSubscriptionStarting;

        const epoch = this._sharedSubscriptionEpoch;
        this._sharedSubscriptionStarting = (async () => {
            const session = await this.getSession();
            const subscription = ClientSubscription.create(session, {
                requestedPublishingInterval: options.publishingInterval,
                requestedLifetimeCount: 100,
                requestedMaxKeepAliveCount: 10,
                maxNotificationsPerPublish: 100,
                publishingEnabled: true,
                priority: 10
            });
            subscription.on("internal_error", (err) => {
                this.lastError = err;
            });
            if (epoch !== this._sharedSubscriptionEpoch) {
                try { await subscription.terminate(); } catch (_e) { /* ignore */ }
                throw new Error("OPC-UA shared subscription was reset while starting");
            }
            this._sharedSubscription = subscription;
            return subscription;
        })();

        try {
            return await this._sharedSubscriptionStarting;
        } finally {
            this._sharedSubscriptionStarting = null;
        }
    }

    /** @private */
    _dropSharedSubscription() {
        this._sharedSubscriptionEpoch++;
        const subscription = this._sharedSubscription;
        this._sharedSubscription = null;
        this._sharedSubscriptionStarting = null;
        if (subscription) {
            try { subscription.terminate(); } catch (_e) { /* ignore */ }
        }
    }

    /** Register interest in this connection (increments ref count). */
    acquire() {
        this.refCount++;
    }

    /**
     * Release interest. When the last consumer releases, the connection is
     * torn down.
     * @returns {Promise<void>}
     */
    async release() {
        this.refCount--;
        if (this.refCount <= 0) {
            this.refCount = 0;
            await this.disconnect();
        }
    }

    /**
     * Close the session and disconnect the client. Safe to call multiple times.
     * @returns {Promise<void>}
     */
    async disconnect() {
        const session = this.session;
        const client = this.client;
        this._dropSharedSubscription();
        this.session = null;
        this.client = null;
        try {
            if (session) {
                await session.close();
            }
            if (client) {
                await client.disconnect();
            }
            this._setState("closed");
        } catch (err) {
            this.lastError = err;
            this._setState("error", err);
        }
    }

    /** @returns {object} lightweight runtime diagnostics */
    diagnostics() {
        return {
            state: this.state,
            endpointUrl: this.config.endpointUrl,
            securityMode: this.config.securityMode || "None",
            securityPolicy: this.config.securityPolicy || "None",
            authType: this.config.authType || "anonymous",
            refCount: this.refCount,
            hasClient: !!this.client,
            hasSession: !!this.session,
            listenerCount: this.listeners.length,
            hasSharedSubscription: !!this._sharedSubscription,
            lastError: this.lastError ? this.lastError.message : null
        };
    }

    /**
     * Register a state listener.
     * @param {(state: string, info?: any) => void} listener
     * @returns {() => void} unsubscribe function
     */
    onState(listener) {
        this.listeners.push(listener);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            this.listeners = this.listeners.filter((l) => l !== listener);
        };
    }

    /** @private emit a state change to all listeners */
    _setState(state, info) {
        this.state = state;
        for (const listener of this.listeners.slice()) {
            try {
                listener(state, info);
            } catch (_e) {
                // a misbehaving listener must not break the manager
            }
        }
    }
}

module.exports = { ConnectionManager };
