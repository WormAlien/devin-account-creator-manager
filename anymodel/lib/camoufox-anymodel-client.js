/**
 * anymodel/lib/camoufox-anymodel-client.js
 * Node.js обёртка над camoufox_anymodel.py
 * Отправляет JSON-команды, получает JSON-ответы.
 */
const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");

class CamoufoxAmodel {
  constructor({ proxy = null, headless = false, logger = () => {} } = {}) {
    this.proxy = proxy;
    this.headless = headless;
    this.logger = logger;
    this._proc = null;
    this._rl = null;
    this._pending = new Map();
    this._id = 0;
    this._ready = new Promise((resolve) => { this._resolveReady = resolve; });
  }

  async start() {
    const scriptPath = path.join(__dirname, "camoufox_anymodel.py");

    const env = { ...process.env };
    if (this.headless) env.HEADLESS = "1";
    if (this.proxy) {
      if (typeof this.proxy === "string") {
        env.PROXY = this.proxy;
      } else {
        env.PROXY = JSON.stringify(this.proxy);
      }
    }

    this._proc = spawn("python", [scriptPath], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this._rl = readline.createInterface({ input: this._proc.stdout });

    this._rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        const handler = this._pending.get("_current");
        if (handler) {
          this._pending.delete("_current");
          handler.resolve(msg);
        }
      } catch (e) {
        this.logger(`[camoufox-anymodel] parse err: ${e.message}`);
      }
    });

    this._proc.stderr.on("data", (d) => {
      const s = d.toString().trim();
      if (s) this.logger(s);
    });

    this._proc.on("error", (e) => {
      this.logger(`[camoufox-anymodel] spawn err: ${e.message}`);
    });

    this._proc.on("close", (code) => {
      this.logger(`[camoufox-anymodel] exited ${code}`);
      const handler = this._pending.get("_current");
      if (handler) {
        this._pending.delete("_current");
        handler.resolve({ ok: false, error: `process exited ${code}` });
      }
    });

    // Ждём少し чтобы процесс стартовал
    await new Promise((r) => setTimeout(r, 2000));
    this._resolveReady();
  }

  async _send(cmd, timeoutMs = 120_000) {
    await this._ready;
    return new Promise((resolve) => {
      const id = ++this._id;
      const timer = setTimeout(() => {
        this._pending.delete("_current");
        resolve({ ok: false, error: "timeout" });
      }, timeoutMs);

      this._pending.set("_current", {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });

      try {
        this._proc.stdin.write(JSON.stringify(cmd) + "\n");
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete("_current");
        resolve({ ok: false, error: `write err: ${e.message}` });
      }
    });
  }

  async register(email, password) {
    return this._send({ cmd: "register", email, password }, 240_000);
  }

  async enterOtp(code) {
    return this._send({ cmd: "enter_otp", code }, 60_000);
  }

  async navigate(url) {
    return this._send({ cmd: "navigate", url }, 60_000);
  }

  async click({ selector, text }) {
    return this._send({ cmd: "click", selector, text }, 30_000);
  }

  async evaluate(code) {
    return this._send({ cmd: "evaluate", code }, 30_000);
  }

  async getUrl() {
    return this._send({ cmd: "get_url" }, 10_000);
  }

  async saveSession(dir) {
    return this._send({ cmd: "save_session", dir }, 30_000);
  }

  async screenshot(name) {
    return this._send({ cmd: "screenshot", name }, 15_000);
  }

  async stop() {
    try {
      await this._send({ cmd: "stop" }, 5_000);
    } catch {}
    if (this._proc && !this._proc.killed) {
      this._proc.kill("SIGTERM");
    }
  }
}

module.exports = { CamoufoxAmodel };
