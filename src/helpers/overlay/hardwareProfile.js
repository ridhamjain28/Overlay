/**
 * Detects what this machine can comfortably run a local model with.
 * CPU and RAM come from Node; GPU/VRAM use nvidia-smi when present, then a
 * Windows CIM query so a laptop without NVIDIA tooling still reports a name
 * and, when the driver exposes it, AdapterRAM.
 */

const os = require("os");
const { execFile } = require("child_process");
const { detectNvidiaGpu } = require("../../utils/gpuDetection");

const GIB = 1024 * 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const LOW_MEMORY_IDLE_TIMEOUT_MS = 90 * 1000;
const LOW_MEMORY_RAM_GIB = 12;
const PREWARM_MIN_RAM_GIB = 8;

function runExecFile(execFileImpl, file, args, options) {
  return new Promise((resolve) => {
    execFileImpl(file, args, options, (error, stdout) => resolve({ error, stdout: stdout || "" }));
  });
}

function parseCimVideoControllers(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return [];
  const blocks = text.includes("\n\n") ? text.split(/\r?\n\s*\r?\n/) : [text];
  const gpus = [];
  for (const block of blocks) {
    const nameMatch = /(?:^|\n)\s*Name\s*:\s*(.+)\s*$/im.exec(block);
    const ramMatch = /(?:^|\n)\s*AdapterRAM\s*:\s*(\d+)\s*$/im.exec(block);
    // PowerShell list format: Name and AdapterRAM on adjacent lines without labels
    // when using `ConvertTo-Csv`. Prefer the labeled CIM table above; also
    // accept "Name,AdapterRAM" csv rows.
    if (nameMatch) {
      const name = nameMatch[1].trim();
      const ram = ramMatch ? parseInt(ramMatch[1], 10) : NaN;
      if (name) {
        gpus.push({
          name,
          vramMb: Number.isFinite(ram) && ram > 0 ? Math.round(ram / (1024 * 1024)) : null,
        });
      }
    }
  }
  if (gpus.length) return gpus;

  const rows = text.split(/\r?\n/).filter((line) => line.trim() && !/^Name\s*,/i.test(line));
  for (const row of rows) {
    const csv = row.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
    if (csv.length >= 1 && csv[0]) {
      const ram = parseInt(csv[1], 10);
      gpus.push({
        name: csv[0],
        vramMb: Number.isFinite(ram) && ram > 0 ? Math.round(ram / (1024 * 1024)) : null,
      });
    }
  }
  return gpus;
}

function pickPreferredGpu(gpus) {
  if (!Array.isArray(gpus) || gpus.length === 0) return null;
  const scored = [...gpus].sort((a, b) => (b.vramMb || 0) - (a.vramMb || 0));
  const discrete = scored.find((g) =>
    /NVIDIA|GeForce|Quadro|Tesla|Radeon|AMD|Intel Arc/i.test(g.name || "")
  );
  return discrete || scored[0];
}

async function queryWindowsVideoControllers(execFileImpl) {
  const { error, stdout } = await runExecFile(
    execFileImpl,
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM | ConvertTo-Csv -NoTypeInformation",
    ],
    { timeout: 15000, windowsHide: true }
  );
  if (error) return { error, gpus: [] };
  return { error: null, gpus: parseCimVideoControllers(stdout) };
}

async function detectGpu(deps = {}) {
  const execFileImpl = deps.execFileImpl || execFile;
  const nvidia = await detectNvidiaGpu(deps);
  if (nvidia?.hasNvidiaGpu) {
    return {
      name: nvidia.gpuName || "NVIDIA GPU",
      vramMb: nvidia.vramMb || null,
      source: nvidia.detectionSource === "wmi" ? "wmi-nvidia" : "nvidia-smi",
    };
  }

  if ((deps.platform || process.platform) === "win32") {
    const wmi = await queryWindowsVideoControllers(execFileImpl);
    const gpu = pickPreferredGpu(wmi.gpus);
    if (gpu) return { ...gpu, source: "wmi" };
  }

  return null;
}

function detectHardwareSync(deps = {}) {
  const osImpl = deps.osImpl || os;
  const cpus = typeof osImpl.cpus === "function" ? osImpl.cpus() || [] : [];
  const totalRamBytes = typeof osImpl.totalmem === "function" ? Number(osImpl.totalmem()) || 0 : 0;
  return {
    cpuCores: cpus.length || 1,
    totalRamBytes,
    totalRamGiB: Math.round((totalRamBytes / GIB) * 10) / 10,
    gpuName: null,
    vramMb: null,
    gpuSource: null,
  };
}

async function detectHardware(deps = {}) {
  const base = detectHardwareSync(deps);
  const gpu = await detectGpu(deps);
  return {
    ...base,
    gpuName: gpu?.name || null,
    vramMb: gpu?.vramMb || null,
    gpuSource: gpu?.source || null,
  };
}

/**
 * Memory a local model may use without starving the OS, Overlay, and (on
 * CPU-only machines) the rest of the session.
 */
function usableMemoryBytes(hardware) {
  const ram = Number(hardware?.totalRamBytes) || 0;
  const vram = (Number(hardware?.vramMb) || 0) * 1024 * 1024;
  if (vram >= 2 * GIB) {
    return Math.floor(vram * 0.85 + ram * 0.25);
  }
  return Math.floor(ram * 0.5);
}

function idleTimeoutMs(hardware) {
  const ram = Number(hardware?.totalRamBytes) || 0;
  if (ram > 0 && ram < LOW_MEMORY_RAM_GIB * GIB) return LOW_MEMORY_IDLE_TIMEOUT_MS;
  return DEFAULT_IDLE_TIMEOUT_MS;
}

function shouldPrewarmLocalModels(hardware) {
  const ram = Number(hardware?.totalRamBytes) || 0;
  return ram >= PREWARM_MIN_RAM_GIB * GIB;
}

module.exports = {
  GIB,
  DEFAULT_IDLE_TIMEOUT_MS,
  LOW_MEMORY_IDLE_TIMEOUT_MS,
  detectHardware,
  detectHardwareSync,
  detectGpu,
  usableMemoryBytes,
  idleTimeoutMs,
  shouldPrewarmLocalModels,
  parseCimVideoControllers,
  pickPreferredGpu,
};
