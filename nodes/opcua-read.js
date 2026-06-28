"use strict";

const { AttributeIds } = require("node-opcua");

const STATUS_MAP = {
    connecting:   { fill: "yellow", shape: "ring", text: "connecting" },
    connected:    { fill: "green",  shape: "dot",  text: "connected" },
    reconnecting: { fill: "yellow", shape: "ring", text: "reconnecting" },
    error:        { fill: "red",    shape: "ring", text: "error" },
    closed:       { fill: "grey",   shape: "ring", text: "closed" }
};

function resolveNodeIds(node, msg) {
    if (Array.isArray(msg.nodeIds)) return msg.nodeIds;
    if (Array.isArray(msg.payload)) return msg.payload;
    return msg.nodeId || node.nodeId;
}

function toReadResult(nodeId, dataValue) {
    return {
        nodeId,
        payload: dataValue.value ? dataValue.value.value : null,
        statusCode: dataValue.statusCode ? dataValue.statusCode.toString() : undefined
    };
}

module.exports = function (RED) {
    function OpcuaReadNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.endpoint = RED.nodes.getNode(config.endpoint);
        node.nodeId = config.nodeId;

        if (!node.endpoint) {
            node.status({ fill: "red", shape: "ring", text: "no endpoint" });
            return;
        }
        const manager = node.endpoint.register();

        const unsubscribeState = manager.onState(function (state) {
            node.status(STATUS_MAP[state] || {});
        });

        node.on("input", async function (msg, send, done) {
            try {
                const nodeIds = resolveNodeIds(node, msg);
                if (!nodeIds || (Array.isArray(nodeIds) && nodeIds.length === 0)) {
                    throw new Error("No nodeId provided");
                }
                const result = await manager.runWithTimeout(async () => {
                    const session = await manager.getSession();
                    if (Array.isArray(nodeIds)) {
                        const nodesToRead = nodeIds.map((nodeId) => ({
                            nodeId,
                            attributeId: AttributeIds.Value
                        }));
                        return session.read(nodesToRead);
                    }
                    return session.read({ nodeId: nodeIds, attributeId: AttributeIds.Value });
                }, "read");

                if (Array.isArray(nodeIds)) {
                    msg.payload = result.map((dataValue, i) => toReadResult(nodeIds[i], dataValue));
                    msg.nodeIds = nodeIds;
                    msg.statusCodes = msg.payload.map((r) => r.statusCode);
                } else {
                    msg.payload = result.value ? result.value.value : null;
                    msg.statusCode = result.statusCode ? result.statusCode.toString() : undefined;
                    msg.nodeId = nodeIds;
                }
                send(msg);
                done();
            } catch (err) {
                node.status({ fill: "red", shape: "ring", text: "read error" });
                done(err);
            }
        });

        node.on("close", async function (done) {
            unsubscribeState();
            await node.endpoint.deregister();
            done();
        });
    }
    RED.nodes.registerType("opcua-read", OpcuaReadNode);
};
