"use client";
import React, { useState, useRef, useCallback } from "react";
import axios from "axios";

// ── Types ─────────────────────────────────────────────────────────────────────
type WeightRow = { id: number; column: string; weight: number };
type TolerancePct = 5 | 10 | 15 | 20 | 25;

const SEGMENT_NAMES = ["Very High", "High", "Medium", "Low", "Very Low"] as const;
type SegmentName = typeof SEGMENT_NAMES[number];

type SegmentRow = {
  segment: SegmentName;
  start_decile: number | null;
  end_decile: number | null;
  calls_per_hcp: number | string;
  target: boolean | null;
};

type AnalyzeResult = {
  calls_required: number;
  decile_table: { decile: string; hcp_count: number; calls_per_hcp: number }[];
  segment_summary: { segment: string; hcp_count: number; calls_per_hcp: number; total_calls: number }[];
  total_hcps: number;
  targeted_hcps: number;
} | null;

type RunResult = { mapHtml: string; statsJson: string } | null;

type AiResult = {
  executive_summary: string;
  outlier_suggestions: { territory: string; issue: string; suggestion: string }[];
  strategic_recommendation: string;
} | null;

const TOLERANCE_OPTIONS: TolerancePct[] = [5, 10, 15, 20, 25];
const DECILES = [10,9,8,7,6,5,4,3,2,1,0];
const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

// ── Derive start deciles ───────────────────────────────────────────────────────
function deriveStartDeciles(rows: SegmentRow[]): SegmentRow[] {
  return rows.map((row, i) => {
    if (i === 0) {
      // First row: start is free (user sets it), default null until set
      return { ...row };
    }
    const prev = rows[i - 1];
    if (prev.end_decile !== null) {
      return { ...row, start_decile: Math.max(0, prev.end_decile - 1) };
    }
    return { ...row, start_decile: null };
  });
}

// ── CSS ───────────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --b5:#1668b8;--b6:#0f5294;--b7:#0b3d70;--b50:#e6f1fb;
  --t4:#1faaa3;
  --bg:#f5f7fa;--sf:#fff;--sf2:#f1f4f8;--sf3:#e6ebf1;
  --bd:#e0e6ed;--bd2:#c7d0db;
  --tx:#0f1d2e;--tx2:#4a5b6e;--tx3:#7d8a98;--tx4:#b3bcc7;
  --ok:#1aa15a;--ok-bg:#e3f5ec;--ok-tx:#0e6e3c;
  --wn:#d18a17;--wn-bg:#fdf3df;--wn-tx:#7a5000;
  --er:#d13b3b;--er-bg:#fbe4e4;--er-tx:#99231f;
  --sans:"Inter",-apple-system,sans-serif;
  --mono:"JetBrains Mono",monospace;
  --r:8px;--rlg:12px;
}
body{font:400 12px/1.5 var(--sans);background:var(--bg);color:var(--tx2)}

.topbar{position:sticky;top:0;z-index:100;height:52px;background:var(--sf);
  border-bottom:1px solid var(--bd);display:flex;align-items:center;padding:0 24px;gap:12px}
.brand{font:600 15px/1 var(--sans);color:var(--b6);display:flex;align-items:center;gap:8px}
.tsep{height:20px;width:1px;background:var(--bd)}
.tlab{font:600 10px/1 var(--sans);text-transform:uppercase;letter-spacing:.4px;color:var(--tx3)}

.page{max-width:1200px;margin:0 auto;padding:24px 24px 60px}
.pg-title{font:600 18px/1 var(--sans);color:var(--tx);margin-bottom:4px}
.pg-sub{font:400 12px/1 var(--sans);color:var(--tx3);margin-bottom:20px}
.grid{display:grid;grid-template-columns:1fr 320px;gap:16px;align-items:start}
@media(max-width:860px){.grid{grid-template-columns:1fr}}

.card{background:var(--sf);border:1px solid var(--bd);border-radius:var(--rlg);margin-bottom:12px}
.ch{display:flex;align-items:center;justify-content:space-between;
  padding:11px 16px;border-bottom:1px solid var(--bd)}
.ch .sn{font:600 10px/1 var(--sans);text-transform:uppercase;letter-spacing:.4px;
  color:var(--tx4);margin-right:8px}
.ch .tt{font:600 13px/1 var(--sans);color:var(--tx)}
.cb{padding:16px}
.div{height:1px;background:var(--bd);margin:14px 0}
.eyebrow{font:600 10px/1 var(--sans);text-transform:uppercase;letter-spacing:.4px;
  color:var(--tx3);display:block;margin-bottom:6px}
.hint{font:400 11px/1.4 var(--sans);color:var(--tx3)}

.drop{border:1.5px dashed var(--bd2);border-radius:var(--r);padding:24px 16px;
  text-align:center;cursor:pointer;position:relative;transition:border-color 150ms}
.drop:hover{border-color:var(--b5)}
.drop.ok{border-color:var(--ok);background:var(--ok-bg)}
.drop input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}

.inp{width:100%;padding:7px 10px;border:1px solid var(--bd2);border-radius:var(--r);
  font:400 12px/1 var(--sans);color:var(--tx);outline:none;background:var(--sf);
  transition:border-color 150ms}
.inp::placeholder{color:var(--tx4)}
.inp:focus{border-color:var(--b5)}
.sel{padding:6px 8px;border:1px solid var(--bd2);border-radius:var(--r);
  font:400 12px/1 var(--sans);color:var(--tx);outline:none;background:var(--sf);
  cursor:pointer;transition:border-color 150ms}
.sel:focus{border-color:var(--b5)}
.sel:disabled{color:var(--tx4);background:var(--sf2);cursor:not-allowed}

.wr{display:flex;gap:8px;align-items:center;margin-bottom:6px}
.wpw{position:relative;width:72px}
.wp{width:100%;padding:7px 20px 7px 8px;border:1px solid var(--bd2);border-radius:var(--r);
  font:500 12px/1 var(--mono);color:var(--tx);text-align:right;outline:none}
.wp:focus{border-color:var(--b5)}
.wpu{position:absolute;right:7px;top:50%;transform:translateY(-50%);
  font:400 11px/1 var(--sans);color:var(--tx3);pointer-events:none}
.wt{font:500 11px/1 var(--sans);color:var(--tx3);margin-top:6px;text-align:right}
.wt.ok{color:var(--ok-tx)} .wt.warn{color:var(--wn-tx)}
.btn-del{width:28px;height:28px;display:flex;align-items:center;justify-content:center;
  border:1px solid transparent;border-radius:var(--r);background:transparent;
  color:var(--tx3);cursor:pointer;flex-shrink:0;transition:all 150ms}
.btn-del:hover{background:var(--er-bg);color:var(--er)}
.ghost-sm{display:inline-flex;align-items:center;gap:4px;font:500 11px/1 var(--sans);
  color:var(--b5);background:none;border:none;cursor:pointer;padding:0}
.ghost-sm:hover{color:var(--b7)}

.seg-table{width:100%;border-collapse:collapse}
.seg-table th{font:600 10px/1 var(--sans);text-transform:uppercase;letter-spacing:.4px;
  color:var(--tx3);padding:6px 8px;border-bottom:1px solid var(--bd);text-align:left;
  background:var(--sf2)}
.seg-table td{padding:6px 8px;border-bottom:1px solid var(--bd);vertical-align:middle}
.seg-table tr:last-child td{border-bottom:none}
.seg-name{font:500 12px/1 var(--sans);color:var(--tx)}
.ro-val{font:500 12px/1 var(--mono);color:var(--tx3);padding:6px 8px;
  background:var(--sf2);border-radius:var(--r);border:1px solid var(--bd);
  display:inline-block;min-width:56px;text-align:center}
.pill-yes{display:inline-flex;align-items:center;padding:3px 8px;border-radius:999px;
  font:500 11px/1 var(--sans);background:var(--ok-bg);color:var(--ok-tx)}
.pill-no{display:inline-flex;align-items:center;padding:3px 8px;border-radius:999px;
  font:500 11px/1 var(--sans);background:var(--sf3);color:var(--tx3)}

/* decile ref table */
.dtable{width:100%;border-collapse:collapse;font:400 12px/1 var(--sans)}
.dtable th{font:600 10px/1 var(--sans);text-transform:uppercase;letter-spacing:.4px;
  color:var(--tx3);padding:6px 10px;border-bottom:1px solid var(--bd);background:var(--sf2);text-align:left}
.dtable td{padding:6px 10px;border-bottom:1px solid var(--bd);color:var(--tx2)}
.dtable tr:last-child td{border-bottom:none}
.dtable .mono{font-family:var(--mono);font-size:12px;color:var(--tx)}
.dpct{font:500 11px/1 var(--mono);color:var(--b5);min-width:36px;display:inline-block;text-align:right}

/* sizing */
.sz-row{display:flex;align-items:center;justify-content:space-between;
  padding:8px 0;border-bottom:1px solid var(--bd)}
.sz-row:last-child{border-bottom:none}
.sz-label{font:400 12px/1 var(--sans);color:var(--tx2)}
.sz-val{font:600 13px/1 var(--mono);color:var(--tx);min-width:80px;text-align:right}
.sz-val.calc{color:var(--b6)}
.sz-inp{width:100px;padding:5px 8px;border:1px solid var(--bd2);border-radius:var(--r);
  font:600 12px/1 var(--mono);color:var(--tx);text-align:right;outline:none;background:var(--sf)}
.sz-inp:focus{border-color:var(--b5)}
.sz-val.ro{background:var(--sf2);padding:5px 8px;border-radius:var(--r);
  border:1px solid var(--bd);color:var(--tx3)}

.btn-run{width:100%;display:flex;align-items:center;justify-content:center;gap:8px;
  padding:10px 16px;background:var(--t4);color:#fff;border:none;
  border-radius:var(--r);font:600 12px/1 var(--sans);cursor:pointer;
  transition:background 150ms;margin-top:12px}
.btn-run:hover:not(:disabled){background:#128a85}
.btn-run:disabled{background:var(--sf3);color:var(--tx4);cursor:not-allowed}

.sl-row{display:flex;align-items:center;gap:12px}
input[type=range]{flex:1;height:4px;border-radius:2px;accent-color:var(--b5);cursor:pointer}
.kn{width:64px;padding:6px 8px;border:1px solid var(--bd2);border-radius:var(--r);
  font:600 13px/1 var(--mono);color:var(--b6);text-align:center;outline:none}
.kn:focus{border-color:var(--b5)}

.tol-g{display:flex;gap:6px;flex-wrap:wrap}
.tb{padding:5px 12px;border:1px solid var(--bd2);border-radius:999px;
  background:var(--sf);font:500 12px/1 var(--sans);color:var(--tx2);
  cursor:pointer;transition:all 150ms}
.tb:hover{border-color:var(--b5);color:var(--b5)}
.tb.on{background:var(--b5);border-color:var(--b5);color:#fff}
.tol-r{font:500 11px/1 var(--mono);color:var(--tx3);margin-top:8px}

/* summary — light card */
.sum{background:var(--sf);border:1px solid var(--bd);border-radius:var(--rlg);padding:18px;margin-bottom:12px}
.sum-t{font:600 13px/1 var(--sans);color:var(--tx);margin-bottom:14px}
.sr{display:flex;justify-content:space-between;align-items:baseline;
  padding:7px 0;border-bottom:1px solid var(--bd);
  font:400 12px/1 var(--sans);color:var(--tx3)}
.sr:last-child{border-bottom:none}
.sv{font:500 12px/1 var(--sans);color:var(--tx)}
.sv.hl{color:var(--b6);font-weight:600}

.btn-p{width:100%;display:flex;align-items:center;justify-content:center;gap:8px;
  padding:11px 16px;background:var(--b5);color:#fff;border:none;
  border-radius:var(--r);font:600 13px/1 var(--sans);cursor:pointer;
  transition:background 150ms;margin-bottom:8px}
.btn-p:hover:not(:disabled){background:var(--b6)}
.btn-p:disabled{background:var(--sf3);color:var(--tx4);cursor:not-allowed}

.alert{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;
  border-radius:var(--r);font:400 11px/1.4 var(--sans);margin-top:8px}
.a-err{background:var(--er-bg);color:var(--er-tx);border:1px solid #f5bcbc}
.a-info{background:var(--b50);color:var(--b7);border:1px solid #9ec9ef}
.a-ok{background:var(--ok-bg);color:var(--ok-tx);border:1px solid #a3d9b8}

.map-panel{margin-top:20px;background:var(--sf);border:1px solid var(--bd);
  border-radius:var(--rlg);overflow:hidden}
.mph{display:flex;align-items:center;justify-content:space-between;
  padding:10px 16px;border-bottom:1px solid var(--bd)}
.mph .tt{font:600 13px/1 var(--sans);color:var(--tx)}
iframe.map{width:100%;height:620px;border:none;display:block}

.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}
.tile{background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:10px 12px}
.tile .tl{font:600 9px/1 var(--sans);text-transform:uppercase;letter-spacing:.4px;color:var(--tx3)}
.tile .tv{font:600 18px/1 var(--mono);color:var(--tx);font-variant-numeric:tabular-nums;margin-top:4px}
.tile .tv.ok{color:var(--ok-tx)} .tile .tv.wn{color:var(--wn-tx)} .tile .tv.er{color:var(--er-tx)}

@keyframes spin{to{transform:rotate(360deg)}}
.spin{animation:spin .8s linear infinite;display:inline-block}

/* Upload loading overlay */
.overlay{position:fixed;inset:0;background:rgba(15,29,46,.55);z-index:999;
  display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px)}
.overlay-card{background:var(--sf);border-radius:var(--rlg);padding:36px 48px;
  text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.25);min-width:280px}
.overlay-title{font:600 15px/1 var(--sans);color:var(--tx);margin:14px 0 6px}
.overlay-sub{font:400 12px/1 var(--sans);color:var(--tx3)}
.overlay-spinner{width:44px;height:44px;border:3px solid var(--sf3);
  border-top-color:var(--b5);border-radius:50%;animation:spin .7s linear infinite;margin:0 auto}

/* AI inference panel */
.ai-panel{background:var(--sf);border:1px solid var(--bd);border-radius:var(--rlg);
  margin-top:16px;overflow:hidden}
.ai-ph{display:flex;align-items:center;gap:10px;padding:12px 16px;
  background:linear-gradient(135deg,#0f1d2e 0%,#1668b8 100%);border-bottom:1px solid var(--bd)}
.ai-ph .tt{font:600 13px/1 var(--sans);color:#fff}
.ai-ph .badge{font:500 10px/1 var(--sans);background:rgba(255,255,255,.18);
  color:#fff;padding:3px 8px;border-radius:999px;letter-spacing:.3px}
.ai-body{padding:20px}
.ai-section{margin-bottom:18px}
.ai-section:last-child{margin-bottom:0}
.ai-section-title{font:600 11px/1 var(--sans);text-transform:uppercase;
  letter-spacing:.5px;color:var(--b5);margin-bottom:8px}
.ai-text{font:400 13px/1.6 var(--sans);color:var(--tx2)}
.ai-card{background:var(--sf2);border:1px solid var(--bd);border-radius:var(--r);
  padding:12px 14px;margin-bottom:8px}
.ai-card:last-child{margin-bottom:0}
.ai-card-t{font:600 12px/1 var(--sans);color:var(--tx);margin-bottom:4px}
.ai-card-issue{font:400 11px/1.4 var(--sans);color:var(--er-tx);margin-bottom:6px}
.ai-card-sug{font:400 11px/1.4 var(--sans);color:var(--ok-tx)}
`;

// ── SVG Icons ─────────────────────────────────────────────────────────────────
const Ic = {
  map: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1.5 3.5l4-1.5 5 2 4-1.5v9.5l-4 1.5-5-2-4 1.5V3.5zM5.5 2v9.5M10.5 4.5V14"/></svg>,
  plus: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M8 3v10M3 8h10"/></svg>,
  trash: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4.5h10M6 4.5V3h4v1.5M5 4.5l.5 8h5l.5-8"/></svg>,
  info: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{flexShrink:0,marginTop:1}}><circle cx="8" cy="8" r="6.5"/><path d="M8 7.5v4M8 5.5v.5"/></svg>,
  check: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{flexShrink:0}}><circle cx="8" cy="8" r="6.5"/><path d="M5 8.5l2 2 4-4"/></svg>,
  spin: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="spin"><path d="M8 1.5A6.5 6.5 0 1114.5 8"/></svg>,
  upload: <svg width="26" height="26" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 11.5v1.5a1 1 0 001 1h9a1 1 0 001-1v-1.5M8 2.5v8M5 5.5l3-3 3 3"/></svg>,
  ok: <svg width="26" height="26" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M5 8.5l2 2 4-4"/></svg>,
  play: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 3l9 5-9 5V3z"/></svg>,
};

// ── Component ─────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [file, setFile] = useState<File | null>(null);
  const [detectedCols, setDetectedCols] = useState<string[]>([]);
  const [detecting, setDetecting] = useState(false);

  const [weights, setWeights] = useState<WeightRow[]>([{ id: 1, column: "", weight: 100 }]);

  // Segments — Very High start_decile is now free (user selects), others derived
  const [segments, setSegments] = useState<SegmentRow[]>([
    { segment: "Very High", start_decile: null, end_decile: null, calls_per_hcp: "", target: null },
    { segment: "High",      start_decile: null, end_decile: null, calls_per_hcp: "", target: null },
    { segment: "Medium",    start_decile: null, end_decile: null, calls_per_hcp: "", target: null },
    { segment: "Low",       start_decile: null, end_decile: null, calls_per_hcp: "", target: null },
    { segment: "Very Low",  start_decile: null, end_decile: null, calls_per_hcp: "", target: null },
  ]);

  const [analyzeResult, setAnalyzeResult] = useState<AnalyzeResult>(null);
  const [workingDays, setWorkingDays] = useState<number>(220);
  const [callsPerDay, setCallsPerDay] = useState<number>(4);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  const [numClusters, setNumClusters] = useState<number>(50);
  const [tolerance, setTolerance] = useState<TolerancePct>(15);

  const [generating, setGenerating] = useState(false);
  const [generatingExcel, setGeneratingExcel] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult>(null);
  const [aiResult, setAiResult] = useState<AiResult>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const mapRef = useRef<HTMLDivElement>(null);

  const minCap = Math.round(1000 * (1 - tolerance / 100));
  const maxCap = Math.round(1000 * (1 + tolerance / 100));
  const totalWeight = weights.reduce((s, r) => s + Number(r.weight || 0), 0);

  const repsRequired = analyzeResult
    ? Math.ceil(analyzeResult.calls_required / (workingDays * callsPerDay))
    : null;

  React.useEffect(() => {
    if (repsRequired && repsRequired > 0) setNumClusters(repsRequired);
  }, [repsRequired]);

  // ── File upload ──────────────────────────────────────────────────────────────
  const handleFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setAnalyzeResult(null);
    setResult(null);
    setAiResult(null);
    setAnalyzeError(null);
    setDetecting(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await axios.post(`${API}/detect_columns`, fd);
      if (res.data.columns) {
        setDetectedCols(res.data.columns);
        const cols: string[] = res.data.columns;
        const eqWeight = cols.length > 0 ? Math.floor(100 / cols.length) : 100;
        const newWeights = cols.map((c, i) => ({
          id: i + 1, column: c,
          weight: i === cols.length - 1 ? 100 - eqWeight * (cols.length - 1) : eqWeight,
        }));
        setWeights(newWeights.length > 0 ? newWeights : [{ id: 1, column: "", weight: 100 }]);
      }
    } catch { /* silent */ }
    finally { setDetecting(false); }
  }, []);

  // ── Segment logic ────────────────────────────────────────────────────────────
  const derivedSegments = deriveStartDeciles(segments);

  const updateSegment = (idx: number, field: keyof SegmentRow, value: unknown) => {
    setSegments(prev => {
      let next = prev.map((r, i) => i === idx ? { ...r, [field]: value } : r);

      // If setting target=true on a row that is NOT "Very High" (idx>0),
      // and "Very High" (idx=0) currently has target=true, turn it off.
      if (field === "target" && value === true && idx > 0) {
        // The segment being activated — if Very High's start overlaps,
        // it means Very High is now redundant; turn it off automatically.
        // Rule: if idx=0 target is true AND idx=1 is being set to true,
        // disable idx=0 target.
        if (idx === 1 && next[0].target === true) {
          next = next.map((r, i) => i === 0 ? { ...r, target: false } : r);
        }
      }

      return deriveStartDeciles(next);
    });
  };

  // When Very High start_decile is set by user (it's free / top row)
  const setVeryHighStart = (val: number | null) => {
    setSegments(prev => {
      const next = prev.map((r, i) => i === 0 ? { ...r, start_decile: val, end_decile: null } : r);
      return deriveStartDeciles(next);
    });
  };

  // End decile options for a given row
  const endDecileOptions = (idx: number): number[] => {
    const row = derivedSegments[idx];
    if (row.start_decile === null) return [];
    const sd = row.start_decile;
    // First topmost active segment: end can equal start (single decile)
    const isTopmost = idx === 0 || derivedSegments.slice(0, idx).every(r => r.end_decile === null);
    return DECILES.filter(d => {
      if (d > sd) return false;
      if (!isTopmost && d >= sd) return false;
      // If start is D0, end must also be D0
      if (sd === 0) return d === 0;
      return true;
    });
  };

  // ── Analyze ──────────────────────────────────────────────────────────────────
  const handleAnalyze = async () => {
    if (!file) { setAnalyzeError("Upload a file first."); return; }
    const validWeights = weights.filter(w => w.column.trim());
    if (validWeights.length === 0) { setAnalyzeError("Define at least one weighted column."); return; }
    if (totalWeight !== 100) { setAnalyzeError("Weights must sum to 100%."); return; }

    const activeSegs = derivedSegments.filter(s => s.target === true);
    for (const s of activeSegs) {
      if (s.start_decile === null || s.end_decile === null || s.calls_per_hcp === "") {
        setAnalyzeError(`${s.segment}: fill Starting Decile, Ending Decile and Calls/HCP before marking as Target.`);
        return;
      }
    }

    setAnalyzing(true); setAnalyzeError(null); setAnalyzeResult(null);
    try {
      const cfg: Record<string,number> = {};
      validWeights.forEach(w => { cfg[w.column.trim()] = Number(w.weight); });
      const segCfg = activeSegs.map(s => ({
        segment: s.segment, start_decile: s.start_decile, end_decile: s.end_decile,
        calls_per_hcp: Number(s.calls_per_hcp), target: true,
      }));
      const fd = new FormData();
      fd.append("file", file);
      fd.append("column_config", JSON.stringify(cfg));
      fd.append("segment_config", JSON.stringify(segCfg));
      const res = await axios.post(`${API}/analyze`, fd, { timeout: 120000 });
      if (res.data.error) throw new Error(res.data.error);
      setAnalyzeResult(res.data);
    } catch (err: unknown) {
      setAnalyzeError(axios.isAxiosError(err) ? err.message : String(err));
    } finally { setAnalyzing(false); }
  };

  // ── Shared form builder ───────────────────────────────────────────────────
  const buildFormData = () => {
    const validWeights = weights.filter(w => w.column.trim());
    const cfg: Record<string,number> = {};
    validWeights.forEach(w => { cfg[w.column.trim()] = Number(w.weight); });
    const fd = new FormData();
    fd.append("file", file!);
    fd.append("num_clusters", String(numClusters));
    fd.append("column_config", JSON.stringify(cfg));
    fd.append("tolerance_pct", String(tolerance));
    return fd;
  };

  const validateInputs = () => {
    if (!file) { setGenError("Upload a file first."); return false; }
    if (weights.filter(w => w.column.trim()).length === 0) {
      setGenError("Define weighted columns first."); return false;
    }
    return true;
  };

  // ── Generate Map only ────────────────────────────────────────────────────
  const handleGenerateMap = async () => {
    if (!validateInputs()) return;
    setGenerating(true); setGenError(null); setResult(null); setAiResult(null);
    try {
      const res = await axios.post(`${API}/optimize_map`, buildFormData(),
        { responseType: "text", timeout: 300000 });
      setResult({ mapHtml: res.data, statsJson: "" });
      setTimeout(() => mapRef.current?.scrollIntoView({ behavior: "smooth" }), 300);
      // Fire AI inference after map loads
      setAiLoading(true);
      try {
        const infFd = new FormData();
        infFd.append("k", String(numClusters));
        infFd.append("tolerance_pct", String(tolerance));
        infFd.append("hard_floor", "650");
        infFd.append("min_cap", String(Math.round(1000*(1-tolerance/100))));
        infFd.append("max_cap", String(Math.round(1000*(1+tolerance/100))));
        infFd.append("stats_json", "{}");
        const infRes = await axios.post(`${API}/ai_inference`, infFd, { timeout: 60000 });
        if (infRes.data && !infRes.data.error) setAiResult(infRes.data);
      } catch { /* non-blocking */ }
      finally { setAiLoading(false); }
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.code === "ECONNABORTED") {
        setGenError("Request timed out — try a smaller K value.");
      } else {
        setGenError("Map generation failed. Check backend logs.");
      }
    } finally { setGenerating(false); }
  };

  // ── Generate Excel only ──────────────────────────────────────────────────
  const handleGenerateExcel = async () => {
    if (!validateInputs()) return;
    setGeneratingExcel(true); setGenError(null);
    try {
      const res = await axios.post(`${API}/optimize_excel`, buildFormData(),
        { responseType: "blob", timeout: 300000 });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([res.data]));
      a.download = "territory_analysis.xlsx"; a.click(); a.remove();
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.code === "ECONNABORTED") {
        setGenError("Request timed out — try a smaller K value.");
      } else {
        setGenError("Excel generation failed. Check backend logs.");
      }
    } finally { setGeneratingExcel(false); }
  };

  // ── Helpers ───────────────────────────────────────────────────────────────────
  const activeSegCount = derivedSegments.filter(s => s.target === true).length;
  const metricsCount = weights.filter(w => w.column.trim()).length;
  const totalHcpInFile = analyzeResult?.total_hcps ?? null;
  const totalDecileHcps = analyzeResult
    ? analyzeResult.decile_table.reduce((s, r) => s + r.hcp_count, 0)
    : 0;

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{CSS}</style>

      {/* File upload overlay */}
      {detecting && (
        <div className="overlay">
          <div className="overlay-card">
            <div className="overlay-spinner" />
            <div className="overlay-title">Analysing your file…</div>
            <div className="overlay-sub">Detecting metric columns</div>
          </div>
        </div>
      )}

      {/* Run analysis overlay */}
      {analyzing && (
        <div className="overlay">
          <div className="overlay-card">
            <div className="overlay-spinner" />
            <div className="overlay-title">Running analysis…</div>
            <div className="overlay-sub">Computing scores, assigning deciles &amp; segments</div>
          </div>
        </div>
      )}

      {/* Generate map overlay */}
      {generating && (
        <div className="overlay">
          <div className="overlay-card">
            <div className="overlay-spinner" />
            <div className="overlay-title">Generating territory map…</div>
            <div className="overlay-sub">Running bisection &amp; rebalancing — usually 30–60 seconds</div>
          </div>
        </div>
      )}

      {/* Generate Excel overlay */}
      {generatingExcel && (
        <div className="overlay">
          <div className="overlay-card">
            <div className="overlay-spinner" />
            <div className="overlay-title">Building Excel report…</div>
            <div className="overlay-sub">Running optimisation &amp; formatting your workbook</div>
          </div>
        </div>
      )}

      {/* Topbar */}
      <div className="topbar">
        <div className="brand">{Ic.map} TerriSense</div>
        <div className="tsep" />
        <span className="tlab">Territory creation</span>
      </div>

      <div className="page">
        <div className="pg-title">Territory optimization</div>
        <div className="pg-sub">Configure metrics, segments, sizing and generate territory map.</div>

        <div className="grid">

          {/* ══ LEFT COLUMN ══ */}
          <div>

            {/* ── Section 01: Upload data ── */}
            <div className="card">
              <div className="ch">
                <div style={{display:"flex",alignItems:"center"}}>
                  <span className="sn">01</span>
                  <span className="tt">Upload data</span>
                </div>
              </div>
              <div className="cb">
                <div className={`drop ${file?"ok":""}`}>
                  <input type="file" accept=".csv,.xlsx" onChange={handleFile} />
                  <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
                    <div style={{color:file?"var(--ok)":"var(--tx4)"}}>
                      {file ? Ic.ok : Ic.upload}
                    </div>
                    <div style={{font:"500 12px/1 var(--sans)",color:file?"var(--ok-tx)":"var(--tx2)"}}>
                      {file ? file.name : "Click or drag CSV / Excel file"}
                    </div>
                    <div style={{font:"400 11px/1 var(--sans)",color:file?"var(--ok)":"var(--tx3)"}}>
                      {file
                        ? `${(file.size/1024).toFixed(0)} KB — ${detectedCols.length} metric columns detected`
                        : "Customer_ID, Customer_Name, City, State, Zip_Code, Metric1…"}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* ── Section 02: Metric weights ── */}
            <div className="card">
              <div className="ch">
                <div style={{display:"flex",alignItems:"center"}}>
                  <span className="sn">02</span>
                  <span className="tt">Metric weights</span>
                </div>
                <button className="ghost-sm" onClick={() =>
                  setWeights(w => [...w, { id: Date.now(), column: "", weight: 0 }])}>
                  {Ic.plus} Add column
                </button>
              </div>
              <div className="cb">
                <div style={{display:"flex",gap:8,marginBottom:6}}>
                  <div style={{flex:1}} className="eyebrow">Column name</div>
                  <div style={{width:72,font:"600 9px/1 var(--sans)",textTransform:"uppercase",letterSpacing:".4px",color:"var(--tx3)"}}>Weight</div>
                  <div style={{width:28}}/>
                </div>
                {weights.map(row => (
                  <div className="wr" key={row.id}>
                    <input className="inp" type="text" placeholder="Exact column header"
                      value={row.column}
                      onChange={e => setWeights(w => w.map(r => r.id===row.id ? {...r,column:e.target.value} : r))}
                    />
                    <div className="wpw">
                      <input className="wp" type="number" value={row.weight}
                        onChange={e => setWeights(w => w.map(r => r.id===row.id ? {...r,weight:+e.target.value} : r))}
                      />
                      <span className="wpu">%</span>
                    </div>
                    <button className="btn-del" onClick={() => setWeights(w => w.filter(r => r.id !== row.id))}>
                      {Ic.trash}
                    </button>
                  </div>
                ))}
                <div className={`wt ${totalWeight===100?"ok":totalWeight>0?"warn":""}`}>
                  Total: {totalWeight}%{totalWeight!==100 ? " — must sum to 100%" : " ✓"}
                </div>
                {totalWeight !== 100 && totalWeight > 0 && (
                  <div className="alert a-err" style={{marginTop:6}}>
                    {Ic.info} Weights sum to {totalWeight}%. Adjust to reach exactly 100% before running analysis.
                  </div>
                )}
                {detectedCols.length > 0 && (
                  <div className="alert a-info" style={{marginTop:8}}>
                    {Ic.info} Metric columns auto-detected from file. Adjust weights as needed.
                  </div>
                )}
              </div>
            </div>

            {/* ── Section 03: Segments & Calls assignment ── */}
            <div className="card">
              <div className="ch">
                <div style={{display:"flex",alignItems:"center"}}>
                  <span className="sn">03</span>
                  <span className="tt">Segments &amp; calls assignment</span>
                </div>
              </div>
              <div className="cb" style={{padding:0}}>
                <table className="seg-table">
                  <thead>
                    <tr>
                      <th>Segment</th>
                      <th>Starting decile</th>
                      <th>Ending decile</th>
                      <th># calls / HCP / yr</th>
                      <th>Target?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {derivedSegments.map((row, idx) => {
                      const endOpts = endDecileOptions(idx);
                      const isLocked = row.start_decile === null && idx > 0 &&
                        derivedSegments[idx-1].end_decile === null;
                      const isTopRow = idx === 0;

                      return (
                        <tr key={row.segment}>
                          <td><span className="seg-name">{row.segment}</span></td>

                          {/* Starting decile — free for top row, derived for rest */}
                          <td>
                            {isTopRow ? (
                              <select className="sel"
                                value={row.start_decile !== null ? row.start_decile : ""}
                                onChange={e => setVeryHighStart(e.target.value === "" ? null : Number(e.target.value))}>
                                <option value="">Choose</option>
                                {DECILES.map(d => (
                                  <option key={d} value={d}>D{d}</option>
                                ))}
                              </select>
                            ) : (
                              <span className="ro-val">
                                {row.start_decile !== null ? `D${row.start_decile}` : "—"}
                              </span>
                            )}
                          </td>

                          {/* Ending decile */}
                          <td>
                            <select className="sel"
                              value={row.end_decile !== null ? row.end_decile : ""}
                              disabled={isLocked || row.start_decile === null}
                              onChange={e => updateSegment(idx, "end_decile",
                                e.target.value === "" ? null : Number(e.target.value))}>
                              <option value="">Choose</option>
                              {endOpts.map(d => (
                                <option key={d} value={d}>D{d}</option>
                              ))}
                            </select>
                          </td>

                          {/* Calls per HCP */}
                          <td>
                            <input className="inp" type="number" min="0"
                              style={{width:90,textAlign:"right"}}
                              placeholder="# calls"
                              value={row.calls_per_hcp}
                              disabled={isLocked}
                              onChange={e => updateSegment(idx, "calls_per_hcp", e.target.value)}
                            />
                          </td>

                          {/* Target */}
                          <td>
                            <select className="sel"
                              value={row.target === null ? "" : row.target ? "yes" : "no"}
                              disabled={isLocked}
                              onChange={e => updateSegment(idx, "target",
                                e.target.value === "" ? null : e.target.value === "yes")}>
                              <option value="">—</option>
                              <option value="yes">Yes</option>
                              <option value="no">No</option>
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {analyzeError && (
                  <div className="alert a-err" style={{margin:"12px 16px"}}>
                    {Ic.info} {analyzeError}
                  </div>
                )}
                <div style={{padding:"12px 16px"}}>
                  <button className="btn-run" onClick={handleAnalyze}
                    disabled={analyzing || !file}>
                    {analyzing ? Ic.spin : Ic.play}
                    {analyzing ? "Running analysis…" : "Run analysis"}
                  </button>
                  <p className="hint" style={{textAlign:"center",marginTop:6}}>
                    Computes composite scores, assigns deciles and segments, calculates calls required.
                  </p>
                </div>
              </div>
            </div>

            {/* ── Section 04: Summary ── */}
            <div className="sum">
              <div className="sum-t">Summary</div>
              <div className="sr">
                <span>File uploaded</span>
                <span className={`sv ${file?"hl":""}`}>{file ? file.name : "—"}</span>
              </div>
              <div className="sr">
                <span>Metrics considered</span>
                <span className="sv">{metricsCount > 0 ? metricsCount : "—"}</span>
              </div>
              <div className="sr">
                <span>Active segments</span>
                <span className="sv">{activeSegCount > 0 ? activeSegCount : "—"}</span>
              </div>
              <div className="sr">
                <span># of calls required to cover HCPs</span>
                <span className={`sv ${analyzeResult?"hl":""}`}>
                  {analyzeResult ? analyzeResult.calls_required.toLocaleString() : "—"}
                </span>
              </div>
              <div className="sr">
                <span># of working days in a year</span>
                <span className="sv">{workingDays}</span>
              </div>
              <div className="sr">
                <span># of calls / day / rep</span>
                <span className="sv">{callsPerDay}</span>
              </div>
              <div className="sr">
                <span># of reps required</span>
                <span className={`sv ${repsRequired?"hl":""}`}>{repsRequired ?? "—"}</span>
              </div>
              <div className="sr">
                <span># of territories selected</span>
                <span className={`sv ${analyzeResult?"hl":""}`}>{numClusters}</span>
              </div>
            </div>

          </div>

          {/* ══ RIGHT COLUMN ══ */}
          <div>

            {/* ── Right 01: Field rep sizing ── */}
            <div className="card">
              <div className="ch">
                <div style={{display:"flex",alignItems:"center"}}>
                  <span className="sn">A</span>
                  <span className="tt">Field rep sizing</span>
                </div>
              </div>
              <div className="cb">
                {analyzeResult && (
                  <div className="tiles">
                    <div className="tile">
                      <div className="tl">Total HCPs</div>
                      <div className="tv">{analyzeResult.total_hcps.toLocaleString()}</div>
                    </div>
                    <div className="tile">
                      <div className="tl">Targeted HCPs</div>
                      <div className="tv ok">{analyzeResult.targeted_hcps.toLocaleString()}</div>
                    </div>
                    <div className="tile">
                      <div className="tl">Segments active</div>
                      <div className="tv">{analyzeResult.segment_summary.length}</div>
                    </div>
                  </div>
                )}
                <div className="sz-row">
                  <span className="sz-label"># of calls required</span>
                  <span className={`sz-val ${analyzeResult ? "calc" : "ro"}`}>
                    {analyzeResult ? analyzeResult.calls_required.toLocaleString() : "—"}
                  </span>
                </div>
                <div className="sz-row">
                  <span className="sz-label"># of working days / year</span>
                  <input className="sz-inp" type="number" value={workingDays}
                    onChange={e => setWorkingDays(+e.target.value)} />
                </div>
                <div className="sz-row">
                  <span className="sz-label"># of calls / day / rep</span>
                  <input className="sz-inp" type="number" value={callsPerDay}
                    onChange={e => setCallsPerDay(+e.target.value)} />
                </div>
                <div className="sz-row" style={{borderBottom:"none",paddingTop:10,
                  borderTop:"1px solid var(--bd)",marginTop:4}}>
                  <span className="sz-label" style={{font:"600 12px/1 var(--sans)",color:"var(--tx)"}}>
                    # of reps required
                  </span>
                  <span className="sz-val" style={{font:"700 16px/1 var(--mono)",
                    color:repsRequired ? "var(--b6)" : "var(--tx4)"}}>
                    {repsRequired ? repsRequired.toLocaleString() : "—"}
                  </span>
                </div>
                {analyzeResult && (
                  <div className="alert a-ok" style={{marginTop:10}}>
                    {Ic.check} K pre-filled with {repsRequired} reps. Adjust in section B if needed.
                  </div>
                )}
              </div>
            </div>

            {/* ── Right 02: No. of Territory & Index Range ── */}
            <div className="card">
              <div className="ch">
                <div style={{display:"flex",alignItems:"center"}}>
                  <span className="sn">B</span>
                  <span className="tt">No. of Territory &amp; Index Range</span>
                </div>
              </div>
              <div className="cb">
                <span className="eyebrow">Target number of territories (K)</span>
                <div className="sl-row" style={{marginBottom:4}}>
                  <input type="range" min="2" max="200" value={numClusters}
                    onChange={e => setNumClusters(+e.target.value)} />
                  <input className="kn" type="number" value={numClusters} min="2" max="200"
                    onChange={e => setNumClusters(Math.min(200,Math.max(2,+e.target.value)))} />
                </div>
                {repsRequired && (
                  <p className="hint">Pre-filled from sizing.{numClusters !== repsRequired
                    ? ` Rep calc suggests ${repsRequired}.` : ""}</p>
                )}

                <div className="div" />

                <span className="eyebrow">Territory size tolerance</span>
                <p className="hint" style={{marginBottom:10}}>
                  Target index is <strong>1,000</strong> per territory. Hard floor is always <strong>650</strong>.
                </p>
                <div className="tol-g">
                  {TOLERANCE_OPTIONS.map(p => (
                    <button key={p} className={`tb ${tolerance===p?"on":""}`}
                      onClick={() => setTolerance(p)}>±{p}%</button>
                  ))}
                </div>
                <div className="tol-r">Range: <span style={{color:"var(--tx)"}}>{minCap} – {maxCap}</span></div>
              </div>
            </div>

            {/* ── Decile reference table ── */}
            {analyzeResult && (
              <div className="card">
                <div className="ch">
                  <span className="tt">Decile reference</span>
                </div>
                <div style={{overflowY:"auto",maxHeight:380}}>
                  <table className="dtable">
                    <thead>
                      <tr>
                        <th style={{width:"30%"}}>Decile</th>
                        <th style={{textAlign:"left",width:"40%"}}>HCPs</th>
                        <th style={{textAlign:"right",width:"30%"}}>% of total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analyzeResult.decile_table.map(row => {
                        const pct = totalDecileHcps > 0
                          ? (row.hcp_count / totalDecileHcps * 100)
                          : 0;
                        return (
                          <tr key={row.decile}>
                            <td><span className="mono">{row.decile}</span></td>
                            <td>
                              <span className="mono">{row.hcp_count.toLocaleString()}</span>
                            </td>
                            <td style={{textAlign:"right"}}>
                              <span className="dpct">{pct.toFixed(1)}%</span>
                            </td>
                          </tr>
                        );
                      })}
                      {totalHcpInFile !== null && (
                        <tr style={{background:"var(--sf2)"}}>
                          <td><span className="mono" style={{fontWeight:600}}>Total</span></td>
                          <td><span className="mono" style={{fontWeight:600}}>{totalDecileHcps.toLocaleString()}</span></td>
                          <td style={{textAlign:"right"}}>
                            <span className="dpct" style={{color:"var(--tx)",fontWeight:600}}>100%</span>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── Generate ── */}
            <div className="card">
              <div className="ch">
                <div style={{display:"flex",alignItems:"center"}}>
                  <span className="sn">Generate</span>
                </div>
              </div>
              <div className="cb">
                <button className="btn-p" onClick={handleGenerateMap}
                  disabled={generating || generatingExcel || !file}
                  style={{marginBottom: "8px"}}>
                  {generating ? Ic.spin : Ic.map}
                  {generating ? "Generating map…" : "Generate territory map"}
                </button>
                <button className="btn-p" onClick={handleGenerateExcel}
                  disabled={generating || generatingExcel || !file}
                  style={{background:"var(--b5, #1668B8)"}}>
                  {generatingExcel ? Ic.spin : "📊"}
                  {generatingExcel ? "Building Excel…" : "Download Excel report"}
                </button>
                <p className="hint" style={{textAlign:"center"}}>
                  Map and Excel run independently — use either or both.
                </p>
                {genError && (
                  <div className="alert a-err">{Ic.info} {genError}</div>
                )}
              </div>
            </div>

          </div>
        </div>

        {/* Map — full width below both columns */}
        {result && (
          <div className="map-panel" ref={mapRef}>
            <div className="mph">
              <span className="tt">Territory map — K={numClusters}</span>
            </div>
            <iframe className="map" srcDoc={result.mapHtml} title="Territory map" />
          </div>
        )}

        {/* AI Inference Panel */}
        {(aiLoading || aiResult) && (
          <div className="ai-panel">
            <div className="ai-ph">
              <span className="tt">AI Territory Analysis</span>
              <span className="badge">Claude</span>
              {aiLoading && <span style={{marginLeft:"auto",opacity:.8}}>{Ic.spin}</span>}
            </div>
            <div className="ai-body">
              {aiLoading && !aiResult && (
                <div style={{color:"var(--tx3)",font:"400 13px/1 var(--sans)",padding:"12px 0"}}>
                  Generating AI insights for your territory design…
                </div>
              )}
              {aiResult && (
                <>
                  <div className="ai-section">
                    <div className="ai-section-title">Executive Summary</div>
                    <div className="ai-text">{aiResult.executive_summary}</div>
                  </div>
                  {aiResult.outlier_suggestions.length > 0 && (
                    <div className="ai-section">
                      <div className="ai-section-title">
                        Outlier Suggestions ({aiResult.outlier_suggestions.length})
                      </div>
                      {aiResult.outlier_suggestions.map((s, i) => (
                        <div className="ai-card" key={i}>
                          <div className="ai-card-t">{s.territory}</div>
                          <div className="ai-card-issue">⚠ {s.issue}</div>
                          <div className="ai-card-sug">✓ {s.suggestion}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="ai-section">
                    <div className="ai-section-title">Strategic Recommendation</div>
                    <div className="ai-text">{aiResult.strategic_recommendation}</div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
