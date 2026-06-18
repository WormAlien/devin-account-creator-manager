// freemodel/lib/camoufox-tmailor-client.js
//
// Node.js обёртка над freemodel/lib/camoufox_tmailor.py.
// Запускает Python-процесс один раз на аккаунт и общается с ним через JSON-lines.
//
// API:
//   const client = new CamoufoxTmailor({ headless: false, log: console.log });
//   await client.start();
//   const { email, accesstoken } = await client.create();
//   const { email, accesstoken } = await client.regenerate();
//   const { code, link } = await client.waitOtp({ timeout: 120, poll: 4, fromHint: "freemodel" });
//   await client.stop();

const { spawn } = require("child_process");
const path = require("path");

class CamoufoxTmailor {
  constructor(opts = {}) {
    this.headless = opts.headless !== false; // default true
    this.log = opts.log || (() => {});
    this.python = opts.python || "python";
    this.script = path.join(__dirname, "camoufox_tmailor.py");
    this.proc = null;
    this.buffer = "";
    this.pending = new Map(); // id -> { resolve, reject }
    this.ready = null;
    this.msgId = 0;
  }

  async start() {
    if (this.proc) return;
    const args = [this.script];
    if (this.headless) args.push("--headless");

    this.log("[camoufox-tmailor] запуск python " + args.join(" "));
    this.proc = spawn(this.python, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: path.dirname(this.script),
    });

    this.proc.stderr.on("data", (data) => {
      const lines = data.toString().trim().split("\n");
      for (const line of lines) {
        if (!line) continue;
        this.log(`[camoufox-tmailor/py] ${line}`);
      }
    });

    this.proc.stdout.on("data", (data) => {
      this.buffer += data.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop(); // оставляем неполную строку
      for (const line of lines) {
        if (!line.trim()) continue;
        this._handleLine(line.trim());
      }
    });

    this.proc.on("error", (err) => {
      this.log(`[camoufox-tmailor] process error: ${err.message}`);
      this._rejectAll(err.message);
    });

    this.proc.on("exit", (code) => {
      this.log(`[camoufox-tmailor] process exited ${code}`);
      this._rejectAll(`process exited ${code}`);
      this.proc = null;
    });

    // Ждём первого лога [start] как индикатор готовности ( Camoufox инициализируется 10-40с).
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("camoufox python не стартовал за 60с")), 60000);
      const onErr = (data) => {
        if (data.toString().includes("[start]")) {
          clearTimeout(to);
          cleanup();
          resolve();
        }
      };
      const onOut = (data) => {
        if (data.toString().includes("[start]")) {
          clearTimeout(to);
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        this.proc.stderr.off("data", onErr);
        this.proc.stdout.off("data", onOut);
      };
      this.proc.stderr.on("data", onErr);
      this.proc.stdout.on("data", onOut);
    });
  }

  _handleLine(line) {
    try {
      const obj = JSON.parse(line);
      // Python отвечает объектом без id, но мы можем привязать к последнему запросу.
      if (this.ready) {
        this.ready(obj);
        this.ready = null;
        return;
      }
      // Если пришло без ожидания — логируем.
      this.log(`[camoufox-tmailor/out] ${line}`);
    } catch (e) {
      this.log(`[camoufox-tmailor/out] ${line}`);
    }
  }

  _rejectAll(msg) {
    if (this.ready) {
      this.ready({ ok: false, error: msg });
      this.ready = null;
    }
  }

  async _send(cmd) {
    if (!this.proc || this.proc.killed) {
      throw new Error("camoufox python process not running");
    }
    return new Promise((resolve, reject) => {
      const line = JSON.stringify(cmd);
      this.log(`[camoufox-tmailor/in] ${line}`);
      this.ready = (res) => {
        if (res && res.ok) resolve(res);
        else reject(new Error((res && res.error) || "unknown error"));
      };
      this.proc.stdin.write(line + "\n", (err) => {
        if (err) reject(err);
      });
    });
  }

  async create() {
    return this._send({ cmd: "create" });
  }

  async regenerate() {
    return this._send({ cmd: "regenerate" });
  }

  async waitOtp(opts = {}) {
    return this._send({
      cmd: "wait_otp",
      timeout: opts.timeout || 120,
      poll: opts.poll || 4,
      from_hint: opts.fromHint || "freemodel",
    });
  }

  async stop() {
    try {
      await this._send({ cmd: "stop" });
    } catch (e) {
      this.log(`[camoufox-tmailor] stop error: ${e.message}`);
    }
    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      this.proc.kill();
    }
    this.proc = null;
  }
}

module.exports = { CamoufoxTmailor };
