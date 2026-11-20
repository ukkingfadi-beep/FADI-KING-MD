import { useState } from 'react';
import { BookOpen, Check, Copy, Download, FileCode2, FolderTree } from 'lucide-react';
import type { SourceFileEntry } from '../types/bot';

interface SourceExplorerProps {
  files: SourceFileEntry[];
  adminToken: string;
}

export function SourceExplorer({ files, adminToken }: SourceExplorerProps) {
  const [selectedPath, setSelectedPath] = useState<string>(
    files[0]?.path || 'config/bot.config.ts'
  );
  const [copied, setCopied] = useState(false);

  const activeFile = files.find((f) => f.path === selectedPath) || files[0];

  async function handleCopy() {
    if (!activeFile) return;
    await navigator.clipboard.writeText(activeFile.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="space-y-8">
      {/* Step-by-Step Setup Guide */}
      <section className="glass-surface rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-white/[0.07]">
          <div className="flex items-center gap-2.5">
            <BookOpen className="w-4 h-4 text-[#A78BFA]" />
            <h2 className="text-lg font-semibold text-white">
              Step-by-Step Setup & Deployment Guide
            </h2>
          </div>

          <a
            href={`/api/source/download?token=${encodeURIComponent(adminToken)}`}
            download="fadi-king-md-bot.zip"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-[#8B5CF6] to-[#7C3AED] hover:from-[#9D74F7] hover:to-[#8B5CF6] text-xs font-semibold text-white transition-all whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            Download Complete Bot (.zip)
          </a>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-5">
          <div className="space-y-2">
            <div className="text-xs font-semibold text-[#A78BFA]">01. Install Dependencies</div>
            <p className="text-xs text-[#B6AFD4] leading-relaxed">
              Extract the ZIP archive, ensure Node.js 20+ (and optional FFmpeg for sticker conversion) is installed, then install packages:
            </p>
            <pre className="p-3 rounded-xl bg-[#090612] border border-white/[0.07] font-mono text-[11px] text-[#E2DCF8] overflow-x-auto">
              npm install
            </pre>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-semibold text-[#A78BFA]">02. Configure .env & VIP Owner</div>
            <p className="text-xs text-[#B6AFD4] leading-relaxed">
              Copy <span className="font-mono text-white">.env.example</span> to <span className="font-mono text-white">.env</span> and set your primary owner phone number (country code, no +) and default prefix:
            </p>
            <pre className="p-3 rounded-xl bg-[#090612] border border-white/[0.07] font-mono text-[11px] text-[#E2DCF8] overflow-x-auto">
{`cp .env.example .env
OWNER_NUMBER="923001234567"
VIP_ONLY_PAIRING=true`}
            </pre>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-semibold text-[#A78BFA]">03. Start & Pair VIP Devices</div>
            <p className="text-xs text-[#B6AFD4] leading-relaxed">
              Launch the bot + control board on port 3000. Generate an 8-digit pairing code from the Pairing Studio or scan QR:
            </p>
            <pre className="p-3 rounded-xl bg-[#090612] border border-white/[0.07] font-mono text-[11px] text-[#E2DCF8] overflow-x-auto">
{`npm run dev
# Production:
npm run build && npm start`}
            </pre>
          </div>
        </div>
      </section>

      {/* Modular Source Code Explorer */}
      <section className="glass-surface rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-white/[0.07]">
          <div className="flex items-center gap-2.5">
            <FolderTree className="w-4 h-4 text-[#A78BFA]" />
            <h3 className="text-base font-semibold text-white">
              Modular Architecture Explorer
            </h3>
          </div>
          {activeFile && (
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-xs text-white transition-colors cursor-pointer"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied File' : 'Copy File'}
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mt-5">
          <div className="lg:col-span-4 space-y-1 max-h-[520px] overflow-y-auto pr-1">
            {files.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => setSelectedPath(file.path)}
                className={`w-full text-left flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-mono transition-colors cursor-pointer ${
                  activeFile?.path === file.path
                    ? 'bg-[#8B5CF6] text-white'
                    : 'text-[#B6AFD4] hover:bg-white/[0.06] hover:text-white'
                }`}
              >
                <FileCode2 className="w-3.5 h-3.5 shrink-0 opacity-80" />
                <span className="truncate">{file.path}</span>
              </button>
            ))}
          </div>

          <div className="lg:col-span-8">
            <pre className="p-4 rounded-xl bg-[#080511] border border-white/[0.08] font-mono text-xs leading-relaxed text-[#E2DCF8] overflow-auto max-h-[520px]">
              {activeFile ? activeFile.content : 'Select a file to inspect source code.'}
            </pre>
          </div>
        </div>
      </section>
    </div>
  );
}
