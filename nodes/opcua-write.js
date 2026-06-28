"use strict";

const { AttributeIds, DataType, Variant, StatusCodes } = require("node-opcua");

const STATUS_MAP = {
    connecting:   { fill: "yellow", shape: "ring", text: "connecting" },
    connected:    { fill: "green",  shape: "dot",  text: "connected" },
    reconnecting: { fill: "yellow", shape: "ring", text: "reconnecting" },
    error:        { fill: "red",    shape: "ring", text: "error" },
    closed:       { fill: "grey",   shape: "ring", text: "closed" }
};

function variantFor(dataTypeName, value) {
    const dataType = DataType[dataTypeName];
    if (dataType === undefined) {
        throw new Error("Unknown dataType: " + dataTypeName);
    }
    return new Variant({ dataType: dataType, value: value });
}

function resolveWrites(node, msg) {
    if (Array.isArray(msg.payload)) {
        return msg.payload.map((item, index) => {
            if (item && typeof item === "object" && !Array.isArray(item)) {
                return {
                    nodeId: item.nodeId || item.topic,
                    value: Object.prototype.hasOwnProperty.call(item, "value") ? item.value : item.payload,
                    dataType: item.dataType || msg.dataType || node.dataType
                };
            }
            return {
                nodeId: Array.isArray(msg.nodeIds) ? msg.nodeIds[index] : undefined,
                value: item,
                dataType: Array.isArray(msg.dataTypes) ? msg.dataTypes[index] : (msg.dataType || node.dataType)
            };
        });
    }
    return [{
        nodeId: msg.nodeId || node.nodeId,
        value: msg.payload,
        dataType: msg.dataType || node.dataType
    }];
}

function toWriteValue(write) {
    if (!write.nodeId) throw new Error("No nodeId provided");
    return {
        nodeId: write.nodeId,
        attributeId: AttributeIds.Value,
        value: {
            value: variantFor(write.dataType, write.value)
        }
    };
}

module.exports = function (RED) {
    function OpcuaWriteNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.endpoint = RED.nodes.getNode(config.endpoint);
        node.nodeId = config.nodeId;
        node.dataType = config.dataType || "Double";

        if (!node.endpoint) {
            node.status({ fill: "red", shape: "ring", text: "no endpoint" });
            return;
        }
        const manager = node.endpoint.register();
        const unsubscribeState = manager.onState((state) => node.status(STATUS_MAP[state] || {}));

        node.on("input", async function (msg, send, done) {
            try {
                const writes = resolveWrites(node, msg);
                if (writes.length === 0) throw new Error("No writes provided");
                const writeValues = writes.map(toWriteValue);

                const statusCodes = await manager.runWithTimeout(async () => {
                    const session = await manager.getSession();
                    return session.write(writeValues.length === 1 ? writeValues[0] : writeValues);
                }, "write");

                if (writeValues.length === 1) {
                    msg.statusCode = statusCodes.toString();
                    msg.nodeId = writes[0].nodeId;
                    if (statusCodes !== StatusCodes.Good) {
                        node.status({ fill: "yellow", shape: "ring", text: statusCodes.name });
                    }
                } else {
                    msg.statusCodes = statusCodes.map((s) => s.toString());
                    msg.nodeIds = writes.map((w) => w.nodeId);
                    if (statusCodes.some((s) => s !== StatusCodes.Good)) {
                        node.status({ fill: "yellow", shape: "ring", text: "partial write" });
                    }
                }
                send(msg);
                done();
            } catch (err) {
                node.status({ fill: "red", shape: "ring", text: "write error" });
                done(err);
            }
        });

        node.on("close", async function (done) {
            unsubscribeState();
            await node.endpoint.deregister();
            done();
        });
    }
    RED.nodes.registerType("opcua-write", OpcuaWriteNode);
};
