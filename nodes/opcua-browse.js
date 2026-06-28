"use strict";

const STATUS_MAP = {
    connecting:   { fill: "yellow", shape: "ring", text: "connecting" },
    connected:    { fill: "green",  shape: "dot",  text: "connected" },
    reconnecting: { fill: "yellow", shape: "ring", text: "reconnecting" },
    error:        { fill: "red",    shape: "ring", text: "error" },
    closed:       { fill: "grey",   shape: "ring", text: "closed" }
};

module.exports = function (RED) {
    function OpcuaBrowseNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.endpoint = RED.nodes.getNode(config.endpoint);
        node.nodeId = config.nodeId || "RootFolder";

        if (!node.endpoint) {
            node.status({ fill: "red", shape: "ring", text: "no endpoint" });
            return;
        }
        const manager = node.endpoint.register();
        const unsubscribeState = manager.onState((state) => node.status(STATUS_MAP[state] || {}));

        node.on("input", async function (msg, send, done) {
            try {
                const nodeId = msg.nodeId || node.nodeId;
                const browseResult = await manager.runWithTimeout(async () => {
                    const session = await manager.getSession();
                    return session.browse(nodeId);
                }, "browse");

                const references = (browseResult.references || []).map((ref) => ({
                    nodeId: ref.nodeId.toString(),
                    browseName: ref.browseName.toString(),
                    displayName: ref.displayName ? ref.displayName.text : undefined,
                    nodeClass: ref.nodeClass,
                    typeDefinition: ref.typeDefinition ? ref.typeDefinition.toString() : undefined
                }));

                msg.payload = references;
                msg.statusCode = browseResult.statusCode ? browseResult.statusCode.toString() : undefined;
                msg.nodeId = nodeId;
                send(msg);
                done();
            } catch (err) {
                node.status({ fill: "red", shape: "ring", text: "browse error" });
                done(err);
            }
        });

        node.on("close", async function (done) {
            unsubscribeState();
            await node.endpoint.deregister();
            done();
        });
    }
    RED.nodes.registerType("opcua-browse", OpcuaBrowseNode);
};
