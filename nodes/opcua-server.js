"use strict";

const path = require("path");
const { ServerManager } = require("./lib/server-manager.js");

const STATUS_MAP = {
    starting: { fill: "yellow", shape: "ring", text: "starting" },
    running:  { fill: "green",  shape: "dot",  text: "running" },
    error:    { fill: "red",    shape: "ring", text: "error" },
    stopped:  { fill: "grey",   shape: "ring", text: "stopped" }
};

module.exports = function (RED) {
    /**
     * Runs an OPC-UA server that exposes Node-RED data.
     *
     * Input:  msg.topic = variable name, msg.payload = new value
     *         (optional msg.dataType when creating a new variable on the fly).
     * Output: emitted when a CLIENT writes a variable:
     *         { topic, payload, nodeId, source: "client" }.
     */
    function OpcuaServerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const variables = (config.variables || []).map((v) => ({
            name: v.name,
            dataType: v.dataType || "Double",
            value: v.value
        }));

        // Which security modes to offer (None defaults on for backward compatibility).
        const securityModes = [];
        if (config.securityNone !== false) securityModes.push("None");
        if (config.securitySign) securityModes.push("Sign");
        if (config.securitySignEncrypt) securityModes.push("SignAndEncrypt");

        // Single user credentials are stored encrypted by Node-RED.
        const username = node.credentials ? node.credentials.username : undefined;
        const password = node.credentials ? node.credentials.password : undefined;

        const userDir = (RED.settings && RED.settings.userDir) || process.cwd();

        node.manager = new ServerManager({
            port: parseInt(config.port, 10) || 4840,
            resourcePath: config.resourcePath || "/UA/NodeRED",
            serverName: config.serverName || "Node-RED OPC-UA Server",
            allowAnonymous: config.allowAnonymous !== false,
            username: username,
            password: password,
            securityModes: securityModes,
            pkiFolder: path.join(userDir, "opcua-pki"),
            acceptUntrusted: config.acceptUntrusted === true,
            folderName: config.folderName || "NodeRED",
            variables: variables,
            onClientWrite: (name, value, nodeId) => {
                node.send({ topic: name, payload: value, nodeId: nodeId, source: "client" });
            }
        });

        // Surface best-practice security advisories in the runtime log.
        node.manager.serverSecurityWarnings().forEach((w) => node.warn(w));

        node.manager.onState((state, info) => {
            if (state === "running") {
                node.status({ fill: "green", shape: "dot", text: "running :" + node.manager.port });
            } else if (state === "error") {
                node.status({ fill: "red", shape: "ring", text: (info && info.message) ? info.message : "error" });
            } else {
                node.status(STATUS_MAP[state] || {});
            }
        });

        node.manager.start().catch((err) => {
            node.error("OPC-UA server failed to start: " + err.message);
        });

        node.on("input", function (msg, send, done) {
            try {
                const name = msg.topic;
                if (!name) throw new Error("msg.topic must be the variable name");
                node.manager.setValue(name, msg.payload, msg.dataType);
                done();
            } catch (err) {
                done(err);
            }
        });

        node.on("close", async function (done) {
            try {
                await node.manager.stop();
            } catch (err) {
                node.error("OPC-UA server stop error: " + err.message);
            }
            done();
        });
    }

    RED.nodes.registerType("opcua-server", OpcuaServerNode, {
        credentials: {
            username: { type: "text" },
            password: { type: "password" }
        }
    });
};
