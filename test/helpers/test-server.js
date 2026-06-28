"use strict";

/**
 * Minimal in-process OPC-UA server for integration tests.
 * Exposes a couple of writable variables under ns=1 so tests can
 * read / write / browse / subscribe without external infrastructure.
 */
const {
    OPCUAServer,
    Variant,
    DataType,
    StatusCodes,
    nodesets
} = require("node-opcua");

async function startTestServer(port = 0) {
    const server = new OPCUAServer({
        port,
        resourcePath: "/UA/TestServer",
        nodeset_filename: [nodesets.standard],
        buildInfo: { productName: "NodeRedOpcuaTestServer", buildNumber: "1" }
    });

    await server.initialize();

    const addressSpace = server.engine.addressSpace;
    const namespace = addressSpace.getOwnNamespace();

    const device = namespace.addObject({
        organizedBy: addressSpace.rootFolder.objects,
        browseName: "TestDevice"
    });

    // A mutable numeric variable (ns=1;s=Temperature)
    let temperature = 25.0;
    namespace.addVariable({
        componentOf: device,
        nodeId: "ns=1;s=Temperature",
        browseName: "Temperature",
        dataType: "Double",
        minimumSamplingInterval: 100,
        value: {
            get: () => new Variant({ dataType: DataType.Double, value: temperature }),
            set: (variant) => {
                temperature = parseFloat(variant.value);
                return StatusCodes.Good;
            }
        }
    });

    // A simple string variable (ns=1;s=Label)
    let label = "hello";
    namespace.addVariable({
        componentOf: device,
        nodeId: "ns=1;s=Label",
        browseName: "Label",
        dataType: "String",
        minimumSamplingInterval: 100,
        value: {
            get: () => new Variant({ dataType: DataType.String, value: label }),
            set: (variant) => {
                label = variant.value;
                return StatusCodes.Good;
            }
        }
    });

    await server.start();
    const endpointUrl = server.getEndpointUrl();

    return {
        server,
        endpointUrl,
        // expose a setter so subscribe tests can trigger a change
        setTemperature: (v) => { temperature = v; },
        async stop() {
            await server.shutdown();
        }
    };
}

module.exports = { startTestServer };
