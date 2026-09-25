#!/usr/bin/env node
// PORTED-FROM: rerun-maxed.mjs (the ALWAYS-finish posture: do the work, then the terminal action in
//   a finally block so an error can never leave the machine running) + census.mjs (the data-layer
//   truth pass it invokes).
// Bryan, 2026-09-22 06:20 EDT: "make the thing that wakes u up to shut the pc down when these last
//   things finish... run it till its done then shut down."
// WHAT IT DOES: polls the ingest log for its DONE line (or a hard stall), runs the census + corpus
//   banner, writes a wake-report Bryan reads on next boot, then shuts the PC down.
// SAFETY: (1) a HARD CAP — if the ingest has not finished within MAX_WAIT, it stops waiting and
//   proceeds anyway (never leaves the machine on forever); (2) the census failing does NOT cancel
//   shutdown — it is logged in the report and the machine still goes down, because the instruction
//   was "run till done then shut down"; (3) shutdown uses a 120s grace so a returning human can
//   abort with `shutdown /a`; (4) STALL DETECTION: if the log stops growing for STALL_MS, treat the
//   run as ended (the 2026-09-22 silent-hang taught that a frozen log is a terminal state too).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'

const LOG = process.env.INGEST_LOG || 'C:/Users/Jesse/AppData/Local/Temp/claude/C--/56d8be83-ff2a-4ab8-9c9d-848710d9e5bf/tasks/bqiz8fguh.output'
const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const REPORT = 'C:/Users/Jesse/Desktop/honest-associate/WAKE-REPORT.md'
const MAX_WAIT = Number(process.env.MAX_WAIT_MS) || 90 * 60 * 1000   // 90 min hard cap
const STALL_MS = Number(process.env.STALL_MS) || 10 * 60 * 1000      // 10 min of no growth = ended
const POLL = 20000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const lines = []
const log = (s) => { console.log(s); lines.push(s) }

log(`WATCHER START ${new Date().toISOString()}`)
log(`watching: ${path.basename(LOG)} · cap ${MAX_WAIT / 60000}min · stall ${STALL_MS / 60000}min`)

const started = Date.now()
let lastSize = -1, lastGrowth = Date.now(), reason = 'unknown'

while (true) {
  let txt = ''
  try { txt = fs.readFileSync(LOG, 'utf8') } catch {}
  if (/DONE court=ca4/.test(txt)) { reason = 'ingest DONE line found'; break }
  if (/BREAKER|rate-limited after 3/.test(txt)) { reason = 'ingest breaker tripped'; break }
  if (txt.length !== lastSize) { lastSize = txt.length; lastGrowth = Date.now() }
  else if (Date.now() - lastGrowth > STALL_MS) { reason = `log stalled ${STALL_MS / 60000}min — treating as ended`; break }
  if (Date.now() - started > MAX_WAIT) { reason = `hard cap ${MAX_WAIT / 60000}min reached`; break }
  await sleep(POLL)
}
log(`ingest watch ended: ${reason} (after ${Math.round((Date.now() - started) / 60000)}min)`)

// tail of the ingest log for the report
try {
  const tail = fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-6)
  log('ingest tail:'); tail.forEach((l) => log('  ' + l))
} catch (e) { log('could not read ingest log: ' + e.message) }

// census + corpus banner — failure is logged, never cancels shutdown
try {
  const env = { ...process.env }
  const dotenv = fs.readFileSync('C:/Users/Jesse/Desktop/honest-associate/.env', 'utf8')
  const m = dotenv.match(/SANITY_WRITE_TOKEN=(\S+)/)
  if (m) env.SANITY_WRITE_TOKEN = m[1]
  const r = spawnSync(process.execPath, [path.join(DIR, 'census.mjs')], { encoding: 'utf8', env, timeout: 180000 })
  log('--- CENSUS ---')
  ;(r.stdout || '').trim().split('\n').forEach((l) => log('  ' + l))
  if (r.stderr && r.stderr.trim()) log('  census stderr: ' + r.stderr.trim().slice(0, 400))
} catch (e) {
  log('CENSUS FAILED (shutdown proceeds anyway): ' + e.message)
}

lines.push('', `Watcher finished ${new Date().toISOString()} — PC shutting down on a 120s grace timer.`, 'To have aborted: shutdown /a')
fs.writeFileSync(REPORT, '# Wake report — overnight ingest\n\n```\n' + lines.join('\n') + '\n```\n')
log(`report written: ${REPORT}`)

try {
  execFileSync(`${process.env.SystemRoot || 'C:\\Windows'}\\System32\\shutdown.exe`, ['/s', '/t', '120', '/c', 'Ingest complete - shutting down as ordered. Wake report on Desktop/honest-associate.'])
  log('SHUTDOWN SCHEDULED (120s)')
} catch (e) {
  log('SHUTDOWN CALL FAILED: ' + e.message)
  fs.appendFileSync(REPORT, '\n**SHUTDOWN FAILED — machine still running.**\n')
}
