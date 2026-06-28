"use strict";

const os = require("os");
const path = require("path");
const should = require("should");
const { AttributeIds } = require("node-opcua");
const { ServerManager } = require("../nodes/lib/server-manager.js");
const { ConnectionManager } = require("../nodes/lib/connection-manager.js");

function tmpPki(tag) {
    return path.join(os.tmpdir(), "nropcua-srvsec-pki", tag + "-" + Date.now() + "-" + Math.floor(Math.random() * 1e6));
}

describe("Server security (integration)", function () {
    this.timeout(40000);

    let srv;

    afterEach(async () => {
        if (srv) { try { await srv.stop(); } catch (_e) {} srv = null; }
    });

    async function client(cfg) {
        const cm = new ConnectionManager(Object.assign({ timeout: 8000 }, cfg));
        try {
            await cm.connect();
            const s = await cm.getSession();
            await s.read({ nodeId: "ns=1;s=Val", attributeId: AttributeIds.Value });
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e.message };
        } finally {
            cm.refCount = 0;
            try { await cm.disconnect(); } catch (_e) {}
        }
    }

    it("enforces username/password and rejects anonymous when configured", async () => {
        const PORT = 4881;
        const URL = "opc.tcp://localhost:" + PORT + "/UA/NodeRED";
        srv = new ServerManager({
            port: PORT,
            allowAnonymous: false,
            username: "operator",
            password: "secret123",
            securityModes: ["None"],
            variables: [{ name: "Val", dataType: "Double", value: "1" }]
        });
        await srv.start();

        (await client({ endpointUrl: URL, securityMode: "None", securityPolicy: "None", authType: "anonymous" }))
            .ok.should.equal(false);
        (await client({ endpointUrl: URL, securityMode: "None", securityPolicy: "None", authType: "username", username: "operator", password: "secret123" }))
            .ok.should.equal(true);
        const wrong = await client({ endpointUrl: URL, securityMode: "None", securityPolicy: "None", authType: "username", username: "operator", password: "nope" });
        wrong.ok.should.equal(false);
    });

    it("offers a SignAndEncrypt endpoint that a secure client can use", async () => {
        const PORT = 4882;
        const URL = "opc.tcp://localhost:" + PORT + "/UA/NodeRED";
        srv = new ServerManager({
            port: PORT,
            allowAnonymous: true,
            securityModes: ["SignAndEncrypt"],
            pkiFolder: tmpPki("server"),
            acceptUntrusted: true, // server trusts the connecting client cert (test)
            variables: [{ name: "Val", dataType: "Double", value: "1" }]
        });
        await srv.start();
        srv.hasSecureMode().should.equal(true);

        const r = await client({
            endpointUrl: URL,
            securityMode: "SignAndEncrypt",
            securityPolicy: "Basic256Sha256",
            authType: "anonymous",
            pkiFolder: tmpPki("client"),
            acceptUntrusted: true
        });
        r.ok.should.equal(true);
    });

    it("warns about insecure configurations", () => {
        const mgr = new ServerManager({
            port: 4883,
            allowAnonymous: true,
            username: "u",
            password: "p",
            securityModes: ["None"]
        });
        const w = mgr.serverSecurityWarnings().join(" ");
        w.should.match(/unsecured 'None'/);
        w.should.match(/credentials over an unencrypted channel/);
    });

    it("warns when anonymous is disabled with no username (locked out)", () => {
        const mgr = new ServerManager({ port: 4884, allowAnonymous: false, securityModes: ["SignAndEncrypt"] });
        mgr.serverSecurityWarnings().join(" ").should.match(/no client will be able to authenticate/);
    });
});
