"use strict";

const {
    DataChangeFilter,
    DataChangeTrigger,
    DeadbandType
} = require("node-opcua");

const STATUS_MAP = {
    connecting:   { fill: "yellow", shape: "ring", text: "connecting" },
    connected:    { fill: "green",  shape: "dot",  text: "connected" },
    reconnecting: { fill: "yellow", shape: "ring", text: "reconnecting" },
    error:        { fill: "red",    shape: "ring", text: "error" },
    closed:       { fill: "grey",   shape: "ring", text: "closed" }
};

function positiveInt(value, fallback) {
    const n = parseInt(value, 10);
    return (Number.isFinite(n) && n > 0) ? n : fallback;
}

function nonNegativeNumber(value, fallback) {
    const n = parseFloat(value);
    return (Number.isFinite(n) && n >= 0) ? n : fallback;
}

function buildDataChangeFilter(node) {
    if (!node.deadbandType || node.deadbandType === "None") return null;
    const deadbandType = DeadbandType[node.deadbandType];
    if (deadbandType === undefined) return null;
    return new DataChangeFilter({
        trigger: DataChangeTrigger[node.trigger] || DataChangeTrigger.StatusValue,
        deadbandType,
        deadbandValue: node.deadbandValue
    });
}

module.exports = function (RED) {
    function OpcuaSubscribeNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.endpoint = RED.nodes.getNode(config.endpoint);
        node.nodeId = config.nodeId;
        node.samplingInterval = positiveInt(config.samplingInterval, 1000);
        node.publishingInterval = positiveInt(config.publishingInterval, 1000);
        node.queueSize = positiveInt(config.queueSize, 10);
        node.deadbandType = config.deadbandType || "None";
        node.deadbandValue = nonNegativeNumber(config.deadbandValue, 0);
        node.trigger = config.trigger || "StatusValue";

        if (!node.endpoint) {
            node.status({ fill: "red", shape: "ring", text: "no endpoint" });
            return;
        }
        if (!node.nodeId) {
            node.status({ fill: "red", shape: "ring", text: "no nodeId" });
            return;
        }

        const manager = node.endpoint.register();
        let monitoredItem = null;
        let starting = false;

        async function teardownMonitoring() {
            const item = monitoredItem;
            monitoredItem = null;
            if (item) {
                await item.terminate();
            }
        }

        async function startMonitoring() {
            if (starting || monitoredItem) return;
            starting = true;
            try {
                monitoredItem = await manager.monitorValue({
                    nodeId: node.nodeId,
                    samplingInterval: node.samplingInterval,
                    publishingInterval: node.publishingInterval,
                    queueSize: node.queueSize,
                    filter: buildDataChangeFilter(node),
                    onChanged: (dataValue) => {
                        node.send({
                            payload: dataValue.value ? dataValue.value.value : null,
                            nodeId: node.nodeId,
                            statusCode: dataValue.statusCode ? dataValue.statusCode.toString() : undefined,
                            sourceTimestamp: dataValue.sourceTimestamp
                        });
                    },
                    onError: (err) => {
                        node.error("OPC-UA monitored item error: " + err.message);
                    }
                });
            } catch (err) {
                node.error("OPC-UA subscribe failed: " + err.message);
                await teardownMonitoring();
            } finally {
                starting = false;
            }
        }

        const unsubscribeState = manager.onState(async function (state) {
            node.status(STATUS_MAP[state] || {});
            if (state === "connected") {
                await startMonitoring();
            } else if (state === "reconnecting" || state === "closed" || state === "error") {
                await teardownMonitoring();
            }
        });

        // Kick off a connection so the subscription arms without needing an input.
        manager.connect().catch((err) => {
            node.error("OPC-UA connect failed: " + err.message);
        });

        node.on("close", async function (done) {
            unsubscribeState();
            await teardownMonitoring();
            await node.endpoint.deregister();
            done();
        });
    }
    RED.nodes.registerType("opcua-subscribe", OpcuaSubscribeNode);
};
