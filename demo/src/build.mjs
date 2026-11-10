// Rebuilds the demo video end to end.
//
//   node demo/src/build.mjs                          every step
//   node demo/src/build.mjs capture compose render   the dashboard changed, the narration did not
//   node demo/src/build.mjs voice compose render     the narration changed (edit demo/src/narration.json first)
//
// Steps
//   capture  real screenshots of the live dashboard (starts dashboard/server.py on port 8791 if it is not running)
//   voice    narration with the media-use audio engine: local Kokoro voice + local word timings
//   compose  HyperFrames project in demo/work/hf, plus demo/demo.srt and demo/narration.txt
//   check    npx hyperframes check (lint, runtime, layout, contrast)
//   render   npx hyperframes render -> demo/demo.mp4, then ffprobe + loudness figures
//
// Needs: Node 22+, ffmpeg, Chrome or Edge, Python 3.10+ with kokoro-onnx and soundfile for the voice,
// and the HyperFrames skills in ~/.claude/skills (media-use holds the audio engine).
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO = resolve(HERE, "..");
const ROOT = resolve(DEMO, "..");
const WORK = join(DEMO, "work");
const HF = join(WORK, "hf");
const HYPERFRAMES = "hyperframes@0.9.28";
const PORT = 8791;
const URL_ = `http://127.0.0.1:${PORT}/`;
const MEDIA_USE = process.env.MEDIA_USE_DIR || join(homedir(), ".claude", "skills", "media-use");
// No usage telemetry, and never let the CLI install or update agent skills as a side effect.
const env = { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1", HYPERFRAMES_SKIP_SKILLS: "1", HYPERFRAMES_TTS_CONCURRENCY: "2" };

const ALL = ["capture", "voice", "compose", "check", "render"];
const steps = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
for (const s of steps) if (!ALL.includes(s)) throw new Error(`unknown step "${s}" (use: ${ALL.join(", ")})`);

const q = (a) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(" ")}`);
  // npx is a .cmd on Windows, so it has to go through the shell
  const viaShell = process.platform === "win32" && (cmd === "npx" || cmd === "npm");
  const r = viaShell
    ? spawnSync([cmd, ...args].map(q).join(" "), { stdio: "inherit", env, shell: true, ...opts })
    : spawnSync(cmd, args, { stdio: "inherit", env, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} failed with exit code ${r.status}`);
}
const up = async () => { try { return (await fetch(URL_)).ok; } catch { return false; } };

mkdirSync(join(HF, "assets"), { recursive: true });
if (!existsSync(join(WORK, "package.json"))) writeFileSync(join(WORK, "package.json"), JSON.stringify({ name: "demo-work", private: true }, null, 2));
if (!existsSync(join(HF, "hyperframes.json"))) {
  writeFileSync(join(HF, "hyperframes.json"), JSON.stringify({ $schema: "https://hyperframes.heygen.com/schema/hyperframes.json", registry: "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry", paths: { blocks: "compositions", components: "compositions/components", assets: "assets" }, media: { autoProxy: true } }, null, 2));
  writeFileSync(join(HF, "meta.json"), JSON.stringify({ id: "hf", name: "hf", createdAt: new Date().toISOString() }, null, 2));
  writeFileSync(join(HF, "package.json"), JSON.stringify({ name: "hf", private: true, type: "module" }, null, 2));
}

let server = null;
try {
  if (steps.includes("capture")) {
    if (!existsSync(join(WORK, "node_modules", "puppeteer-core"))) run("npm", ["install", "--prefix", WORK, "puppeteer-core@24", "--no-audit", "--no-fund"]);
    if (!(await up())) {
      const py = join(ROOT, ".venv", "Scripts", "python.exe");
      console.log(`\nstarting the dashboard on port ${PORT}`);
      server = spawn(existsSync(py) ? py : "python", [join(ROOT, "dashboard", "server.py"), "--port", String(PORT)], { stdio: "ignore" });
      for (let i = 0; i < 60 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
      if (!(await up())) throw new Error(`the dashboard did not come up at ${URL_}`);
    }
    run("node", [join(HERE, "capture.mjs"), "--url", URL_]);
  }

  if (steps.includes("voice")) {
    const n = JSON.parse(readFileSync(join(HERE, "narration.json"), "utf8"));
    writeFileSync(join(HF, "audio_request.json"), JSON.stringify({
      provider: "kokoro", voice: n.voice, lang: "en", speed: n.speed,
      lines: n.beats.map((b) => ({ id: b.id, text: b.say })), bgm: { mode: "none" },
    }, null, 1));
    run("node", [join(MEDIA_USE, "audio", "scripts", "audio.mjs"), "--request", join(HF, "audio_request.json"), "--hyperframes", HF, "--out", join(HF, "audio_meta.json"), "--only", "tts"]);
    const meta = JSON.parse(readFileSync(join(HF, "audio_meta.json"), "utf8"));
    console.log("\nwhat the transcriber heard (check names and numbers):");
    for (const v of meta.voices) console.log(`  ${v.id}: ${v.words.map((w) => w.text).join(" ")}`);
    if (meta.voices.length !== n.beats.length) throw new Error("some narration lines have no audio");
  }

  if (steps.includes("compose")) run("node", [join(HERE, "compose.mjs")]);
  if (steps.includes("check")) run("npx", ["--yes", HYPERFRAMES, "check"], { cwd: HF });

  if (steps.includes("render")) {
    const raw = join(WORK, "render.mp4");
    run("npx", ["--yes", HYPERFRAMES, "render", "--quality", "looks", "--crf", "20", "--workers", "3", "--output", raw], { cwd: HF });
    const out = join(DEMO, "demo.mp4");
    run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", raw, "-c", "copy", "-movflags", "+faststart", out]);
    const probe = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", out], { encoding: "utf8" }).stdout);
    const v = probe.streams.find((s) => s.codec_type === "video"), a = probe.streams.find((s) => s.codec_type === "audio");
    const timing = JSON.parse(readFileSync(join(HF, "timing.json"), "utf8"));
    console.log(`\n${out}\n  video ${v.codec_name} ${v.width}x${v.height} ${v.r_frame_rate} · audio ${a?.codec_name} ${a?.sample_rate} Hz · ${(+probe.format.duration).toFixed(2)} s (planned ${timing.total} s) · ${(statSync(out).size / 1e6).toFixed(1)} MB`);
    const loud = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", out, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    console.log(`  loudness ${/I:\s+(-?[\d.]+) LUFS/.exec(loud.slice(loud.lastIndexOf("Summary")))?.[1]} LUFS · peak ${/Peak:\s+(-?[\d.]+) dBFS/.exec(loud.slice(loud.lastIndexOf("Summary")))?.[1]} dBFS`);
    if (v.width !== 1920 || v.height !== 1080 || !a || Math.abs(+probe.format.duration - timing.total) > 0.3) throw new Error("the rendered file does not match the plan");
  }
} finally {
  if (server) server.kill();
}
