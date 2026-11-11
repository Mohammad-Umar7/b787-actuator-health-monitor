// Speaks the narration of the Day 2 demo video with the local Kokoro voice (the same engine as the Day 1 video).
//   node demo/day2/voice.mjs
// Reads demo/day2/narration.json, writes demo/day2/work/hf/assets/voice/*.wav and audio_meta.json (durations and word timings).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HF = join(HERE, "work", "hf");
const MEDIA_USE = process.env.MEDIA_USE_DIR || join(homedir(), ".claude", "skills", "media-use");
const env = { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1", HYPERFRAMES_SKIP_SKILLS: "1", HYPERFRAMES_TTS_CONCURRENCY: "2" };

mkdirSync(join(HF, "assets"), { recursive: true });
if (!existsSync(join(HF, "hyperframes.json"))) {
  writeFileSync(join(HF, "hyperframes.json"), JSON.stringify({ $schema: "https://hyperframes.heygen.com/schema/hyperframes.json", registry: "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry", paths: { blocks: "compositions", components: "compositions/components", assets: "assets" }, media: { autoProxy: true } }, null, 2));
  writeFileSync(join(HF, "meta.json"), JSON.stringify({ id: "hf", name: "hf", createdAt: new Date().toISOString() }, null, 2));
  writeFileSync(join(HF, "package.json"), JSON.stringify({ name: "hf", private: true, type: "module" }, null, 2));
}
const n = JSON.parse(readFileSync(join(HERE, "narration.json"), "utf8"));
writeFileSync(join(HF, "audio_request.json"), JSON.stringify({
  provider: "kokoro", voice: n.voice, lang: "en", speed: n.speed,
  lines: n.beats.map((b) => ({ id: b.id, text: b.say })), bgm: { mode: "none" },
}, null, 1));
const r = spawnSync("node", [join(MEDIA_USE, "audio", "scripts", "audio.mjs"), "--request", join(HF, "audio_request.json"), "--hyperframes", HF, "--out", join(HF, "audio_meta.json"), "--only", "tts"], { stdio: "inherit", env });
if (r.status !== 0) throw new Error(`the voice step failed with exit code ${r.status}`);
const meta = JSON.parse(readFileSync(join(HF, "audio_meta.json"), "utf8"));
let total = 0;
for (const v of meta.voices) { total += v.duration_s; console.log(`  ${v.id} ${v.duration_s.toFixed(1)} s: ${v.words.map((w) => w.text).join(" ")}`); }
console.log(`speech in total: ${total.toFixed(1)} s`);
if (meta.voices.length !== n.beats.length) throw new Error("some narration lines have no audio");
