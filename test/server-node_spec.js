"use strict";

const should = require("should");
const helper = require("node-red-node-test-helper");
const {
    OPCUAClient, AttributeIds, DataType, Variant
} = require("node-opcua");

const serverNode = require("../nodes/opcua-server.js");

helper.init(require.resolve("node-red"));

describe("opcua-server node (integration)", function () {
    this.timeout(20000);

    const PORT = 4863;
    const URL = "opc.tcp://localhost:" + PORT + "/UA/NodeRED";

    beforeEach(() => helper.startServer());
    afterEach(async () => {
        await helper.unload();
        await helper.stopServer();
    });

    function flow(extra) {
        return [Object.assign({
            id: "srv", type: "opcua-server", name: "test server",
            port: PORT, resourcePath: "/UA/NodeRED",
            allowAnonymous: true,
            variables: [{ name: "Setpoint", dataType: "Double", value: "0" }],
            wires: [["h1"]]
        }, extra || {}), { id: "h1", type: "helper" }];
    }

    async function withClient(fn) {
        const client = OPCUAClient.create({ endpointMustExist: false });
        await client.connect(URL);
        const session = await client.createSession();
        try { return await fn(session); }
        finally { await session.close(); await client.disconnect(); }
    }

    it("serves input-updated values to a reading client", function (done) {
        helper.load(serverNode, flow(), function () {
            const srv = helper.getNode("srv");
            // give the server a moment to start listening
            setTimeout(async () => {
                try {
                    srv.receive({ topic: "Setpoint", payload: 55.5 });
                    await new Promise((r) => setTimeout(r, 300));
                    const v = await withClient((s) =>
                        s.read({ nodeId: "ns=1;s=Setpoint", attributeId: AttributeIds.Value })
                    );
                    v.value.value.should.equal(55.5);
                    done();
                } catch (e) { done(e); }
            }, 1500);
        });
    });

    it("emits an output message when a client writes", function (done) {
        helper.load(serverNode, flow(), function () {
            const h1 = helper.getNode("h1");
            h1.on("input", function (msg) {
                try {
                    msg.topic.should.equal("Setpoint");
                    msg.payload.should.equal(12.75);
                    msg.source.should.equal("client");
                    done();
                } catch (e) { done(e); }
            });
            setTimeout(() => {
                withClient((s) => s.write({
                    nodeId: "ns=1;s=Setpoint",
                    attributeId: AttributeIds.Value,
                    value: { value: new Variant({ dataType: DataType.Double, value: 12.75 }) }
                })).catch(done);
            }, 1500);
        });
    });
});
