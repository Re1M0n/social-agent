import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { chat } from "../llm.js";

describe("chat con reintentos", () => {
  let server: Server | undefined;
  let base = "";
  let calls = 0;

  before(async () => {
    server = createServer((req, res) => {
      calls++;
      if (calls < 3) {
        // Fallos transitorios primero (simula red caída / 5xx).
        if (calls === 1) {
          req.destroy();
          return;
        }
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "temporal" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "respuesta final" } }] }));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const addr = server!.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  after(() => {
    server?.closeAllConnections();
    server?.close();
  });

  it("reintenta tras errores transitorios y devuelve la respuesta", async () => {
    const result = await chat(
      { baseUrl: base, apiKey: "k", model: "test" },
      [{ role: "user", content: "hola" }],
    );
    assert.equal(result, "respuesta final");
    assert.ok(calls >= 3, `hizo ${calls} llamadas`);
  });

  it("acumula chunks de streaming SSE", async () => {
    const sse = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "Ho" } }] }) + "\n\n");
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "la" } }] }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    });
    return new Promise<void>(async (resolve, reject) => {
      sse.listen(0, "127.0.0.1", async () => {
        try {
          const addr = sse.address();
          const base3 = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
          const result = await chat({ baseUrl: base3, apiKey: "k", model: "t" }, [{ role: "user", content: "x" }]);
          assert.equal(result, "Hola");
          sse.closeAllConnections();
          sse.close();
          resolve();
        } catch (err) {
          sse.closeAllConnections();
          sse.close();
          reject(err);
        }
      });
    });
  });

  it("no reintenta errores 4xx permanentes", async () => {
    let badCalls = 0;
    const counting = createServer((_req, res) => {
      badCalls++;
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "bad" }));
    });
    await new Promise<void>((r) => counting.listen(0, "127.0.0.1", r));
    const addr = counting.address();
    const base2 = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    await assert.rejects(() => chat({ baseUrl: base2, apiKey: "k", model: "t" }, [{ role: "user", content: "x" }]));
    assert.equal(badCalls, 1, "solo 1 llamada ante 400");
    counting.closeAllConnections();
    counting.close();
  });
});
