"use strict";

const should = require("should");
const {
    OPCUAClient, AttributeIds, DataType, Variant
} = require("node-opcua");
const { ServerManager } = require("../nodes/lib/server-manager.js");

describe("ServerManager (integration)", function () {
    this.timeout(20000);

    let mgr;
    let client;
    let session;
    const PORT = 4862;
    const URL = "opc.tcp://localhost:" + PORT + "/UA/NodeRED";

    afterEach(async () => {
        if (session) { try { await session.close(); } catch (_e) {} session = null; }
        if (client) { try { await client.disconnect(); } catch (_e) {} client = null; }
        if (mgr) { try { await mgr.stop(); } catch (_e) {} mgr = null; }
    });

    async function connect() {
        client = OPCUAClient.create({ endpointMustExist: false });
        await client.connect(URL);
        session = await client.createSession();
    }

    it("starts and serves a configured variable that clients can read", async () => {
        mgr = new ServerManager({
            port: PORT,
            variables: [{ name: "Temperature", dataType: "Double", value: "21.5" }]
        });
        const states = [];
        mgr.onState((s) => states.push(s));
        await mgr.start();
        mgr.state.should.equal("running");
        states.should.containEql("starting");
        states.should.containEql("running");

        await connect();
        const dv = await session.read({ nodeId: "ns=1;s=Temperature", attributeId: AttributeIds.Value });
        dv.value.value.should.equal(21.5);
    });

    it("reflects Node-RED-driven setValue() to reading clients", async () => {
        mgr = new ServerManager({
            port: PORT,
            variables: [{ name: "Temperature", dataType: "Double", value: "0" }]
        });
        await mgr.start();
        mgr.setValue("Temperature", 88.25);

        await connect();
        const dv = await session.read({ nodeId: "ns=1;s=Temperature", attributeId: AttributeIds.Value });
        dv.value.value.should.equal(88.25);
    });

    it("fires onClientWrite when a client writes a variable", async () => {
        const writes = [];
        mgr = new ServerManager({
            port: PORT,
            variables: [{ name: "Setpoint", dataType: "Double", value: "0" }],
            onClientWrite: (name, value, nodeId) => writes.push({ name, value, nodeId })
        });
        await mgr.start();

        await connect();
        const sc = await session.write({
            nodeId: "ns=1;s=Setpoint",
            attributeId: AttributeIds.Value,
            value: { value: new Variant({ dataType: DataType.Double, value: 33.5 }) }
        });
        sc.toString().should.match(/Good/);

        writes.length.should.equal(1);
        writes[0].name.should.equal("Setpoint");
        writes[0].value.should.equal(33.5);
        mgr.getValue("Setpoint").should.equal(33.5);
    });

    it("creates a variable on the fly via setValue()", async () => {
        mgr = new ServerManager({ port: PORT });
        await mgr.start();
        mgr.setValue("Dynamic", 7, "Int32");
        mgr.listVariables().should.containEql("Dynamic");

        await connect();
        const dv = await session.read({ nodeId: "ns=1;s=Dynamic", attributeId: AttributeIds.Value });
        dv.value.value.should.equal(7);
    });

    it("buffers setValue() calls made before start()", async () => {
        mgr = new ServerManager({ port: PORT });
        mgr.setValue("Early", 12, "Int32");
        mgr.listVariables().should.containEql("Early");
        mgr.diagnostics().pendingValueCount.should.equal(1);

        await mgr.start();
        mgr.diagnostics().pendingValueCount.should.equal(0);
        mgr.getValue("Early").should.equal(12);

        await connect();
        const dv = await session.read({ nodeId: "ns=1;s=Early", attributeId: AttributeIds.Value });
        dv.value.value.should.equal(12);
    });

    it("reports server diagnostics", async () => {
        mgr = new ServerManager({
            port: PORT,
            variables: [{ name: "Temperature", dataType: "Double", value: "21.5" }]
        });
        await mgr.start();

        const diagnostics = mgr.diagnostics();
        diagnostics.state.should.equal("running");
        diagnostics.port.should.equal(PORT);
        diagnostics.endpointUrl.should.match(new RegExp(":" + PORT + "/UA/NodeRED$"));
        diagnostics.variableCount.should.equal(1);
        should(diagnostics.lastError).equal(null);
    });
});
