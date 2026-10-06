import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, test } from "vitest";

import { GOLDEN } from "./helpers/canvas.js";

const CLI = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const ID = "recovery-canvas-id-001";
const TOKEN = "recovery-token-0000001";
const BASE_REV = 7;

type JsonObject = Record<string, unknown>;
type RemoteCanvas = { rev: number; document: JsonObject };
type RequestRecord = {
  method: string;
  ifMatch: string | null;
  document: JsonObject | undefined;
};
type KillMode = "none" | "before-commit" | "after-commit";

const json = (
  response: ServerResponse,
  status: number,
  body: unknown,
): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const readBody = async (
  request: AsyncIterable<Buffer>,
): Promise<JsonObject> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject;
};

const links = (api: string) => ({
  viewUrl: `${api}/c/${ID}`,
  embedUrl: `${api}/c/${ID}.svg`,
  editUrl: `${api}/c/${ID}#w=${TOKEN}`,
});

const startFakeCanvas = async (initial: JsonObject) => {
  const state: {
    api: string;
    canvas: RemoteCanvas;
    requests: RequestRecord[];
    killMode: KillMode;
    child: ChildProcess | undefined;
  } = {
    api: "",
    canvas: { rev: BASE_REV, document: initial },
    requests: [],
    killMode: "none",
    child: undefined,
  };

  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    if (request.url !== `/api/canvas/${ID}`) {
      json(response, 404, { error: { code: "NOT_FOUND", message: "missing" } });
      return;
    }

    if (method === "GET") {
      state.requests.push({ method, ifMatch: null, document: undefined });
      json(response, 200, {
        id: ID,
        rev: state.canvas.rev,
        ...links(state.api),
        document: state.canvas.document,
        tiles: [],
      });
      return;
    }

    if (method !== "PUT") {
      json(response, 404, { error: { code: "NOT_FOUND", message: "missing" } });
      return;
    }

    const document = await readBody(request);
    const ifMatch = request.headers["if-match"] ?? null;
    state.requests.push({
      method,
      ifMatch: Array.isArray(ifMatch) ? (ifMatch[0] ?? null) : ifMatch,
      document,
    });

    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      json(response, 404, { error: { code: "NOT_FOUND", message: "missing" } });
      return;
    }
    if (ifMatch !== String(state.canvas.rev)) {
      json(response, 409, {
        error: {
          code: "REVISION_MOVED",
          message: "The canvas has moved on since you pulled it",
          rev: state.canvas.rev,
        },
      });
      return;
    }

    if (state.killMode === "before-commit") {
      state.killMode = "none";
      state.child?.kill("SIGKILL");
      response.destroy();
      return;
    }

    state.canvas = { rev: state.canvas.rev + 1, document };
    if (state.killMode === "after-commit") {
      state.killMode = "none";
      state.child?.kill("SIGKILL");
      response.destroy();
      return;
    }

    json(response, 200, {
      id: ID,
      rev: state.canvas.rev,
      ...links(state.api),
      tiles: [],
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("fake Canvas did not get a TCP port");
  state.api = `http://127.0.0.1:${address.port}`;
  return { server, state };
};

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );

const reversedKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonObject)
      .reverse()
      .map(([key, child]) => [key, reversedKeys(child)]),
  );
};

let checkout = "";
let documentA: JsonObject;
let initialDocument: JsonObject;
let server: Server | undefined;

beforeEach(async () => {
  checkout = await mkdtemp(join(tmpdir(), "contour-push-recovery-"));
  documentA = JSON.parse(await readFile(GOLDEN, "utf8")) as JsonObject;
  initialDocument = { ...documentA, title: "Earlier remote document" };
});

afterEach(async () => {
  if (server !== undefined) await close(server);
  server = undefined;
  await rm(checkout, { recursive: true, force: true });
});

const writeCheckout = async (api: string, document: unknown): Promise<void> => {
  await mkdir(join(checkout, ".contour"), { recursive: true });
  await writeFile(
    join(checkout, ".contour", "canvas.json"),
    JSON.stringify({
      canvases: {
        [ID]: {
          name: "recovery test",
          source: "drawn.graph.json",
          api,
          writeToken: TOKEN,
          rev: BASE_REV,
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    join(checkout, "drawn.graph.json"),
    JSON.stringify(document, null, 2),
    "utf8",
  );
};

const registryEntry = async (): Promise<JsonObject> => {
  const registry = JSON.parse(
    await readFile(join(checkout, ".contour", "canvas.json"), "utf8"),
  ) as { canvases: Record<string, JsonObject> };
  const entry = registry.canvases[ID];
  if (entry === undefined)
    throw new Error("recovery test registry lost its canvas");
  return entry;
};

const runCli = (state: {
  api: string;
  child: ChildProcess | undefined;
}): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CLI, "canvas", "push", "drawn.graph.json", "--api", state.api],
      { cwd: checkout, stdio: ["ignore", "pipe", "pipe"] },
    );
    state.child = child;
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      state.child = undefined;
      resolve({ code, signal, stderr });
    });
  });

test("blocker 1: a committed push is recovered after the service kills the CLI before answering", async () => {
  const fake = await startFakeCanvas(initialDocument);
  server = fake.server;
  await writeCheckout(fake.state.api, documentA);

  fake.state.killMode = "after-commit";
  const first = await runCli(fake.state);
  expect(first.signal ?? first.code).not.toBe(0);
  expect(fake.state.canvas.rev).toBe(BASE_REV + 1);
  expect(fake.state.canvas.document).toEqual(documentA);
  expect((await registryEntry()).rev).toBe(BASE_REV);

  // Serialization alone is not a document change.
  await writeFile(
    join(checkout, "drawn.graph.json"),
    JSON.stringify(reversedKeys(documentA), null, 4),
    "utf8",
  );
  const second = await runCli(fake.state);

  expect(second).toMatchObject({ code: 0, signal: null });
  expect((await registryEntry()).rev).toBe(BASE_REV + 1);
  expect(fake.state.canvas).toEqual({ rev: BASE_REV + 1, document: documentA });
  expect(
    fake.state.requests.filter(({ method }) => method === "PUT"),
  ).toHaveLength(1);
});

test("blocker 2: another writer is not mistaken for the unresolved local push", async () => {
  const fake = await startFakeCanvas(initialDocument);
  server = fake.server;
  await writeCheckout(fake.state.api, documentA);
  const beforeAttempt = await registryEntry();

  fake.state.killMode = "before-commit";
  const first = await runCli(fake.state);
  expect(first.signal ?? first.code).not.toBe(0);
  expect(fake.state.canvas).toEqual({
    rev: BASE_REV,
    document: initialDocument,
  });

  // Treat the recovery representation as opaque: a correct implementation
  // must durably distinguish this checkout from the pre-attempt checkout,
  // without falsely acknowledging a new revision.
  const unresolved = await registryEntry();
  expect(unresolved).not.toEqual(beforeAttempt);
  expect(unresolved.rev).toBe(BASE_REV);

  const documentC = { ...documentA, title: "Another writer's document" };
  fake.state.canvas = { rev: BASE_REV + 1, document: documentC };
  const second = await runCli(fake.state);

  expect(second.code).toBe(1);
  expect(second.stderr).toContain("[CANVAS_CONFLICT]");
  expect(fake.state.canvas).toEqual({ rev: BASE_REV + 1, document: documentC });
  expect(await registryEntry()).toEqual(unresolved);
});

test("blocker 3: a changed local document is pushed from the recovered revision", async () => {
  const fake = await startFakeCanvas(initialDocument);
  server = fake.server;
  await writeCheckout(fake.state.api, documentA);

  fake.state.killMode = "after-commit";
  const first = await runCli(fake.state);
  expect(first.signal ?? first.code).not.toBe(0);

  const documentB = { ...documentA, title: "Changed local document" };
  await writeFile(
    join(checkout, "drawn.graph.json"),
    JSON.stringify(documentB, null, 2),
    "utf8",
  );
  const second = await runCli(fake.state);

  expect(second).toMatchObject({ code: 0, signal: null });
  expect(fake.state.canvas).toEqual({ rev: BASE_REV + 2, document: documentB });
  expect((await registryEntry()).rev).toBe(BASE_REV + 2);
  const puts = fake.state.requests.filter(({ method }) => method === "PUT");
  expect(puts).toHaveLength(2);
  expect(puts.map(({ ifMatch }) => ifMatch)).toEqual([
    String(BASE_REV),
    String(BASE_REV + 1),
  ]);
  expect(puts.map(({ document }) => document)).toEqual([documentA, documentB]);
});

test("an unresolved push that did not land is safely continued from its original revision", async () => {
  const fake = await startFakeCanvas(initialDocument);
  server = fake.server;
  await writeCheckout(fake.state.api, documentA);

  fake.state.killMode = "before-commit";
  const first = await runCli(fake.state);
  expect(first.signal ?? first.code).not.toBe(0);
  const second = await runCli(fake.state);

  expect(second).toMatchObject({ code: 0, signal: null });
  expect(fake.state.canvas).toEqual({ rev: BASE_REV + 1, document: documentA });
  expect((await registryEntry()).rev).toBe(BASE_REV + 1);
  const puts = fake.state.requests.filter(({ method }) => method === "PUT");
  expect(puts.map(({ ifMatch }) => ifMatch)).toEqual([
    String(BASE_REV),
    String(BASE_REV),
  ]);
});
