"use strict";

/**
 * Standalone OPC-UA test server on a FIXED port for manual / container testing.
 * Exposes:
 *   ns=1;s=Temperature  Double, auto-increments every 1s (drives subscribe tests)
 *   ns=1;s=Label        String, writable
 *   ns=1;s=Setpoint     Double, writable (drives write tests)
 *
 * Usage: node test/helpers/standalone-server.js [port]
 */
const {
    OPCUAServer, Variant, DataType, StatusCodes, nodesets
} = require("node-opcua");

const port = parseInt(process.argv[2], 10) || 4841;

(async () => {
    const server = new OPCUAServer({
        port,
        resourcePath: "/UA/TestServer",
        nodeset_filename: [nodesets.standard],
        buildInfo: { productName: "NodeRedOpcuaStandaloneTestServer", buildNumber: "1" }
    });

    await server.initialize();
    const addressSpace = server.engine.addressSpace;
    const namespace = addressSpace.getOwnNamespace();
    const device = namespace.addObject({
        organizedBy: addressSpace.rootFolder.objects,
        browseName: "TestDevice"
    });

    let temperature = 20.0;
    namespace.addVariable({
        componentOf: device, nodeId: "ns=1;s=Temperature", browseName: "Temperature",
        dataType: "Double", minimumSamplingInterval: 100,
        value: { get: () => new Variant({ dataType: DataType.Double, value: temperature }) }
    });

    let label = "hello";
    namespace.addVariable({
        componentOf: device, nodeId: "ns=1;s=Label", browseName: "Label",
        dataType: "String", minimumSamplingInterval: 100,
        value: {
            get: () => new Variant({ dataType: DataType.String, value: label }),
            set: (v) => { label = v.value; return StatusCodes.Good; }
        }
    });

    let setpoint = 0.0;
    namespace.addVariable({
        componentOf: device, nodeId: "ns=1;s=Setpoint", browseName: "Setpoint",
        dataType: "Double", minimumSamplingInterval: 100,
        value: {
            get: () => new Variant({ dataType: DataType.Double, value: setpoint }),
            set: (v) => { setpoint = parseFloat(v.value); return StatusCodes.Good; }
        }
    });

    // Drive subscribe tests: temperature drifts every second.
    setInterval(() => { temperature = Math.round((temperature + 0.5) * 100) / 100; }, 1000);

    await server.start();
    console.log("STANDALONE_OPCUA_READY port=" + port);
    console.log("endpoint=" + server.getEndpointUrl());

    process.on("SIGINT", async () => { await server.shutdown(); process.exit(0); });
    process.on("SIGTERM", async () => { await server.shutdown(); process.exit(0); });
})().catch((e) => { console.error("SERVER_FAIL", e); process.exit(1); });
