"use strict";

const path = require("path");
const { ConnectionManager } = require("./lib/connection-manager.js");

module.exports = function (RED) {
    /**
     * Configuration node describing a single OPC-UA server endpoint and owning
     * the shared ConnectionManager that operation nodes attach to.
     */
    function OpcuaEndpointNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.endpointUrl = config.endpointUrl;
        node.securityMode = config.securityMode || "None";
        node.securityPolicy = config.securityPolicy || "None";
        node.authType = config.authType || "anonymous";
        node.timeout = config.timeout;
        node.acceptUntrusted = config.acceptUntrusted === true;

        // Persist the PKI (client app certificate + trusted/rejected server certs)
        // under the Node-RED user directory so it survives restarts.
        const userDir = (RED.settings && RED.settings.userDir) || process.cwd();
        node.pkiFolder = path.join(userDir, "opcua-pki");

        // Credentials (username/password) are stored securely by Node-RED.
        const username = node.credentials ? node.credentials.username : undefined;
        const password = node.credentials ? node.credentials.password : undefined;

        node.manager = new ConnectionManager({
            endpointUrl: node.endpointUrl,
            securityMode: node.securityMode,
            securityPolicy: node.securityPolicy,
            authType: node.authType,
            username,
            password,
            timeout: node.timeout,
            pkiFolder: node.pkiFolder,
            acceptUntrusted: node.acceptUntrusted,
            applicationName: "node-red-opcua"
        });

        // Surface best-practice advisories in the runtime log.
        node.manager.securityWarnings().forEach((w) => node.warn(w));

        /**
         * Operation nodes call this to obtain the shared manager and register
         * themselves as a consumer (ref-counted). They must call
         * `deregister()` on close.
         * @returns {ConnectionManager}
         */
        node.register = function () {
            node.manager.acquire();
            return node.manager;
        };

        /** Operation node teardown hook. */
        node.deregister = async function () {
            try {
                await node.manager.release();
            } catch (err) {
                node.error("OPC-UA release error: " + err.message);
            }
        };

        node.on("close", async function (done) {
            try {
                // Force a full teardown regardless of ref count on config redeploy.
                node.manager.refCount = 0;
                await node.manager.disconnect();
            } catch (err) {
                node.error("OPC-UA endpoint close error: " + err.message);
            }
            done();
        });
    }

    RED.nodes.registerType("opcua-endpoint", OpcuaEndpointNode, {
        credentials: {
            username: { type: "text" },
            password: { type: "password" }
        }
    });
};
