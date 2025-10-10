import React, { useMemo, useRef, useState } from "react";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";

/**
 * Per‑Diem Web App — Country/City Dataset v3.1 (German rules)
 * ------------------------------------------------------------------
 * Fixes & tweaks in this patch:
 * - 🛠️ Fix CSV export newline: use "\n" (previously caused unterminated string).
 * - 🛠️ Fix CSV parsing regex: use /\r?\n/ (previous regex was broken by a line break).
 * - 🛠️ Fix minor DOM typo in ReportPreview table header (</th>).
 * - ✅ Keeps breakfast deduction = 20% of FULL even on HALF days.
 * - ✅ Keeps Country → City dataset dropdowns, "Other" label (else "All").
 * - ✅ Keeps unit tests and adds a couple more for edge cases.
 */

// ---------------- Types ----------------

type DatasetEntry = { country: string; city: string | null; full_day_eur: number; eight_plus_eur: number };

type Leg = {
  id: string;
  startUtc: string; // ISO yyyy-MM-ddTHH:mm (UTC)
  endUtc: string;   // ISO yyyy-MM-ddTHH:mm (UTC)
  country: string;
  city: string | null; // null = country-wide; "Other" allowed
  notes?: string;
};

type DayResult = {
  dateUtc: string; // yyyy-MM-dd
  rateRef: { country: string; city: string | null };
  hours: number;
  band: "NONE" | "HALF" | "FULL";
  baseAmount: number;
  breakfastTaken: boolean;
  breakfastDeduction: number; // 20% of FULL if breakfastTaken & (HALF|FULL)
  total: number;
  contributingLegIds: string[];
};

type TestResult = { name: string; pass: boolean; details?: string };

type UserProfile = { empId: string; name: string };

// ---------------- Constants & LocalStorage ----------------

const LS_USERS = "pd_users_v1";
const LS_DATASET = "pd_dataset_v1";

function loadUsers(): UserProfile[] { try { const raw = localStorage.getItem(LS_USERS); return raw ? JSON.parse(raw) : []; } catch { return []; } }
function saveUsers(users: UserProfile[]) { try { localStorage.setItem(LS_USERS, JSON.stringify(users)); } catch {} }

function loadDataset(): DatasetEntry[] | null { try { const raw = localStorage.getItem(LS_DATASET); return raw ? JSON.parse(raw) : null; } catch { return null; } }
function saveDataset(ds: DatasetEntry[]) { try { localStorage.setItem(LS_DATASET, JSON.stringify(ds)); } catch {} }

// Small built‑in sample. On server, place full JSON at /per_diem_2025.json and it will be fetched.
const DEFAULT_DATASET: DatasetEntry[] = [
  { country: "Germany", city: null, full_day_eur: 28, eight_plus_eur: 14 },
  { country: "France", city: "Paris", full_day_eur: 58, eight_plus_eur: 39 },
  { country: "France", city: "Other", full_day_eur: 53, eight_plus_eur: 36 },
  { country: "United Kingdom", city: "London", full_day_eur: 66, eight_plus_eur: 44 },
  { country: "United Kingdom", city: "Other", full_day_eur: 52, eight_plus_eur: 35 },
];

// Default logo (always visible). For local/testing this path works in canvas. For GitHub Pages, put the PNG in /public and set URL accordingly.
const DEFAULT_LOGO_URL = "/mnt/data/WAJ Logo Horizontal Positive + Origin - white bg no border 15percent.png";

// ---------------- Utilities ----------------

const ymd = (d: Date) => d.toISOString().slice(0,10);
const isoToDate = (iso: string) => new Date(iso + (iso.endsWith("Z")?"":"Z"));
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const hoursBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3_600_000;

function eachUtcDay(start: Date, end: Date): string[] {
  const days: string[] = [];
  let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const endDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (d.getTime() <= endDay.getTime()) { days.push(ymd(d)); d = new Date(d.getTime() + 86_400_000); }
  return days;
}

function clampDaySegmentHours(day: string, s: Date, e: Date) {
  const dayStart = new Date(day + "T00:00:00Z");
  const dayEnd = new Date(day + "T23:59:59Z");
  const start = Math.max(s.getTime(), dayStart.getTime());
  const end = Math.min(e.getTime(), dayEnd.getTime());
  const ms = Math.max(0, end - start + 1000);
  return ms/3_600_000;
}

function formatMoney(n: number) { return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(n); }

// ---------------- Core calc ----------------

function computePerDiem(legs: Leg[], dataset: DatasetEntry[], breakfastOverrides: Record<string, boolean>): DayResult[] {
  if (!legs.length) return [];

  const norm = legs.map(l => ({ ...l, s: isoToDate(l.startUtc), e: isoToDate(l.endUtc) }))
                   .sort((a,b) => a.s.getTime() - b.s.getTime());

  const tripStart = norm[0].s;
  const tripEnd = norm[norm.length - 1].e;
  const crossesMidnight = ymd(tripStart) !== ymd(tripEnd);
  const tripHours = hoursBetween(tripStart, tripEnd);

  function rateFor(country: string, city: string | null): DatasetEntry | undefined {
    let found = dataset.find(d => d.country === country && (d.city || "") === (city || ""));
    if (found) return found;
    found = dataset.find(d => d.country === country && (d.city || "") === "Other");
    if (found) return found;
    return dataset.find(d => d.country === country && d.city === null);
  }

  const dayHours = new Map<string, { hours: number; legIds: string[] }>();
  const dayLastLegSel = new Map<string, { country: string; city: string | null }>();

  for (const l of norm) {
    const days = eachUtcDay(l.s, l.e);
    for (const d of days) {
      const h = clampDaySegmentHours(d, l.s, l.e);
      if (h <= 0) continue;
      const rec = dayHours.get(d) || { hours: 0, legIds: [] };
      rec.hours += h;
      if (!rec.legIds.includes(l.id)) rec.legIds.push(l.id);
      dayHours.set(d, rec);
      if (ymd(l.e) === d) dayLastLegSel.set(d, { country: l.country, city: l.city });
    }
  }

  function buildDayResult(d: string, hrs: number): DayResult {
    const sel = dayLastLegSel.get(d) || { country: norm[0].country, city: norm[0].city };
    const rate = rateFor(sel.country, sel.city || null);
    const full = rate?.full_day_eur ?? 0;
    const halfVal = rate?.eight_plus_eur ?? 0;

    let band: "NONE" | "HALF" | "FULL" = "NONE";
    if (hrs >= 24 - 1e-6) band = "FULL"; else if (hrs > 8) band = "HALF";
    const baseAmount = band === "FULL" ? full : band === "HALF" ? halfVal : 0;
    const breakfastTaken = !!breakfastOverrides[d];
    const breakfastDeduction = (breakfastTaken && (band === "FULL" || band === "HALF")) ? round2(full * 0.20) : 0;
    const total = round2(baseAmount - breakfastDeduction);

    return { dateUtc: d, rateRef: sel, hours: round2(hrs), band, baseAmount: round2(baseAmount), breakfastTaken, breakfastDeduction, total, contributingLegIds: dayHours.get(d)?.legIds || [] };
  }

  // Special: cross‑midnight but total < 24h → single HALF (if total>8h) on majority day
  if (crossesMidnight && tripHours < 24 - 1e-6) {
    const days = Array.from(dayHours.keys()).sort();
    if (days.length === 2) {
      const [d1,d2] = days; const h1 = dayHours.get(d1)?.hours || 0; const h2 = dayHours.get(d2)?.hours || 0;
      const totalH = h1 + h2; const majority = h1 >= h2 ? d1 : d2;
      const out: DayResult[] = [];
      for (const d of days) {
        const r = buildDayResult(d, dayHours.get(d)?.hours || 0);
        if (totalH > 8) {
          if (d === majority) {
            const rate = rateFor(r.rateRef.country, r.rateRef.city || null);
            r.band = "HALF";
            r.baseAmount = round2(rate?.eight_plus_eur || 0);
            r.breakfastDeduction = r.breakfastTaken ? round2((rate?.full_day_eur || 0) * 0.20) : 0;
            r.total = round2(r.baseAmount - r.breakfastDeduction);
          } else {
            r.band = "NONE"; r.baseAmount = 0; r.breakfastDeduction = 0; r.total = 0;
          }
        }
        out.push(r);
      }
      return out.sort((a,b) => a.dateUtc.localeCompare(b.dateUtc));
    }
  }

  // Multi‑day (≥24h) → start/end days are HALF by rule
  const daysSorted = Array.from(dayHours.keys()).sort();
  const multiDay = daysSorted.length >= 2 && tripHours >= 24 - 1e-6;
  const firstDay = daysSorted[0];
  const lastDay = daysSorted[daysSorted.length - 1];

  const results: DayResult[] = [];
  for (const d of daysSorted) {
    const hrs = dayHours.get(d)?.hours || 0;
    let band: "NONE" | "HALF" | "FULL" = "NONE";
    if (hrs >= 24 - 1e-6) band = "FULL";
    else if (multiDay && (d === firstDay || d === lastDay)) band = "HALF";
    else if (hrs > 8) band = "HALF";

    let r = buildDayResult(d, hrs);
    if (r.band !== band) r.band = band;
    const rate = rateFor(r.rateRef.country, r.rateRef.city || null);
    r.baseAmount = round2(band === "FULL" ? (rate?.full_day_eur || 0) : band === "HALF" ? (rate?.eight_plus_eur || 0) : 0);
    r.breakfastDeduction = (r.breakfastTaken && (band === "FULL" || band === "HALF")) ? round2((rate?.full_day_eur || 0) * 0.20) : 0;
    r.total = round2(r.baseAmount - r.breakfastDeduction);
    results.push(r);
  }
  return results;
}

// ---------------- Main App ----------------

export default function App() {
  const stored = loadDataset();
  const [dataset, setDataset] = useState<DatasetEntry[]>(stored || DEFAULT_DATASET);

  // Try to fetch server‑side JSON once (optional): place per_diem_2025.json in public root when deploying
  React.useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/per_diem_2025.json", { cache: "no-store" });
        if (res.ok) {
          const j = await res.json();
          const flat: DatasetEntry[] = Array.isArray(j) ? j : (j?.countries ? j.countries.flatMap((c: any)=> c.entries.map((e: any)=>({ country:c.country, city:e.city??null, full_day_eur:+e.full_day_eur, eight_plus_eur:+e.eight_plus_eur }))) : []);
          if (flat.length) { setDataset(flat); saveDataset(flat); }
        }
      } catch {}
    })();
  }, []);

  const firstCountry = dataset[0]?.country || "";
  const firstCity = dataset.find(d => d.country === firstCountry && d.city !== null)?.city || null;

  const [legs, setLegs] = useState<Leg[]>([{
    id: crypto.randomUUID(),
    startUtc: new Date().toISOString().slice(0,16),
    endUtc: new Date(Date.now()+4*3_600_000).toISOString().slice(0,16),
    country: firstCountry,
    city: firstCity,
  }]);

  const [users, setUsers] = useState<UserProfile[]>(() => loadUsers());
  const [currentEmpId, setCurrentEmpId] = useState<string>(() => (loadUsers()[0]?.empId) || "");
  const [crewName, setCrewName] = useState<string>(loadUsers().find(u => u.empId === (loadUsers()[0]?.empId))?.name || "");
  const [reportMonth, setReportMonth] = useState<string>(new Date().toISOString().slice(0,7));
  const [breakfastOverrides, setBreakfastOverrides] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<TestResult[] | null>(null);
  const [logoUrl] = useState<string>(DEFAULT_LOGO_URL);
  const reportRef = useRef<HTMLDivElement>(null);

  const calc = useMemo(() => computePerDiem(legs, dataset, breakfastOverrides), [legs, dataset, breakfastOverrides]);
  const total = useMemo(() => round2(calc.reduce((a,b) => a + b.total, 0)), [calc]);

  function countries() { return Array.from(new Set(dataset.map(d => d.country))).sort(); }
  function citiesFor(country: string): string[] {
    const list = dataset.filter(d => d.country === country);
    const cities = Array.from(new Set(list.map(d => (d.city || "")))).sort();
    if (!cities.length) return [""]; // show "All"
    return cities;
  }

  function addLeg(copyPrev=false) {
    const last = legs[legs.length - 1];
    const start = last ? new Date(isoToDate(last.endUtc).getTime() + 60_000) : new Date();
    const end = new Date(start.getTime() + 2*3_600_000);
    const c = copyPrev && last ? last.country : (dataset[0]?.country || "");
    const cityList = citiesFor(c);
    const city = copyPrev && last ? last.city : ((cityList[0] || "") || null);
    setLegs(ls => [...ls, { id: crypto.randomUUID(), startUtc: start.toISOString().slice(0,16), endUtc: end.toISOString().slice(0,16), country: c, city }]);
  }
  function updateLeg(id: string, patch: Partial<Leg>) { setLegs(ls => ls.map(l => l.id === id ? { ...l, ...patch } as Leg : l)); }
  function deleteLeg(id: string) { setLegs(ls => ls.filter(l => l.id !== id)); }

  function exportCSV(){
    const header = ["Employee ID","Crew","Month","Date (UTC)", "Country","City","Hours", "Band", "Base (EUR)", "Breakfast?", "Breakfast Deduction (EUR)", "Total (EUR)", "Leg IDs" ];
    const rows = calc.map(d => [currentEmpId || "", crewName || "", reportMonth, d.dateUtc, d.rateRef.country, d.rateRef.city || "", d.hours.toFixed(2), d.band, d.baseAmount.toFixed(2), d.breakfastTaken ? "YES" : "NO", d.breakfastDeduction.toFixed(2), d.total.toFixed(2), d.contributingLegIds.join("|")]);
    const esc = (v: unknown) => `"${String(v).replaceAll('"','""')}"`;
    const csv = [header, ...rows].map(r => r.map(esc).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `per_diem_${reportMonth}.csv`; a.click(); URL.revokeObjectURL(url);
  }

  async function exportPdf() {
    const node = reportRef.current; if (!node) return;
    const canvas = await html2canvas(node, { scale: 2, useCORS: true, backgroundColor: "#ffffff" });
    const imgData = canvas.toDataURL("image/png");
    const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const margin = 36; const imgWidth = pageWidth - margin * 2; const ratio = canvas.height / canvas.width; const imgHeight = imgWidth * ratio;
    pdf.addImage(imgData, "PNG", margin, margin, imgWidth, imgHeight);
    pdf.setFontSize(8); pdf.text(`Generated ${new Date().toLocaleString()}`, margin, pdf.internal.pageSize.getHeight() - margin/2);
    pdf.save(`PerDiem-${reportMonth}.pdf`);
  }

  // Users
  function upsertUser(empIdRaw: string, name: string) {
    const empId = (empIdRaw || "").toUpperCase().trim();
    if (!/^([A-Z]{3})$/.test(empId)) { alert("Employee ID must be exactly 3 letters (A–Z)"); return; }
    const next = [...loadUsers().filter(u => u.empId !== empId), { empId, name }].sort((a,b)=>a.empId.localeCompare(b.empId));
    setUsers(next); saveUsers(next);
  }
  function removeUser(empId: string) { const next = loadUsers().filter(u => u.empId !== empId); setUsers(next); saveUsers(next); if (currentEmpId === empId) { const f = next[0]; setCurrentEmpId(f?.empId || ""); setCrewName(f?.name || ""); } }
  function switchUser(empId: string) { setCurrentEmpId(empId); const u = loadUsers().find(x => x.empId === empId); setCrewName(u?.name || ""); }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Toolbar */}
        <header className="flex flex-wrap md:flex-nowrap items-center justify-between gap-3">
          <div className="flex flex-wrap md:flex-nowrap items-center gap-3">
            <UserBar users={users} currentEmpId={currentEmpId} crewName={crewName}
              onSwitch={switchUser} onUpsert={upsertUser} onRemove={removeUser} />
            <div className="flex items-center gap-2 bg-white border rounded-2xl px-3 py-2 min-w-[220px]">
              <label className="text-xs text-gray-600">Month</label>
              <input type="month" className="border-0 outline-none text-sm" value={reportMonth} onChange={e => setReportMonth(e.target.value)} />
            </div>
            {/* Company logo always visible */}
            <div className="flex items-center gap-2 bg-white border rounded-2xl px-3 py-2 min-w-[220px]">
              <img src={logoUrl} alt="Logo" className="h-6 object-contain" />
              <span className="text-xs text-gray-500">Company Logo</span>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button onClick={exportCSV} className="px-4 py-2 rounded-2xl shadow bg-white border hover:shadow-md">Export CSV</button>
            <button onClick={exportPdf} className="px-4 py-2 rounded-2xl shadow bg-white border hover:shadow-md">Export PDF</button>
          </div>
        </header>

        <section className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <TripBuilder dataset={dataset} legs={legs} onAdd={addLeg} onUpdate={updateLeg} onDelete={deleteLeg} countries={countries()} citiesFor={citiesFor} />
            <ResultsTable calc={calc} onToggleBreakfast={(dateUtc, val)=>setBreakfastOverrides(p=>({ ...p, [dateUtc]: val }))} />
          </div>
          <div className="space-y-6">
            <DatasetLoader onLoad={(d)=>{ setDataset(d); saveDataset(d); }} previewRows={5} />
            <DevPanel onRun={()=>runDevTests(setTestResults)} results={testResults} />
          </div>
        </section>

        <ReportPreview refObj={reportRef} logoUrl={logoUrl} crewName={crewName} empId={currentEmpId} reportMonth={reportMonth} calc={calc} total={total} />
      </div>
    </div>
  );
}

// ---------------- Components ----------------

function DatasetLoader({ onLoad, previewRows = 5 }:{ onLoad: (d: DatasetEntry[]) => void; previewRows?: number; }){
  const [preview, setPreview] = useState<DatasetEntry[] | null>(null);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const txt = String(reader.result || "");
      try {
        if (f.name.toLowerCase().endsWith('.json')) {
          const json = JSON.parse(txt);
          const flat: DatasetEntry[] = [];
          if (Array.isArray(json)) {
            for (const r of json) flat.push({ country: r.country, city: r.city ?? null, full_day_eur: Number(r.full_day_eur), eight_plus_eur: Number(r.eight_plus_eur) });
          } else if (json?.countries) {
            for (const c of json.countries) for (const e of c.entries) flat.push({ country: c.country, city: e.city ?? null, full_day_eur: Number(e.full_day_eur), eight_plus_eur: Number(e.eight_plus_eur) });
          }
          onLoad(flat); setPreview(flat.slice(0, previewRows));
          return;
        }
        // CSV: country,city,full_day_eur,eight_plus_eur
        const lines = txt.split(/\r?\n/).filter(Boolean);
        const header = lines.shift()?.split(',').map(s=>s.trim().toLowerCase())||[];
        const idxCountry = header.indexOf('country');
        const idxCity = header.indexOf('city');
        const idxFull = header.indexOf('full_day_eur');
        const idxEight = header.indexOf('eight_plus_eur');
        const out: DatasetEntry[] = [];
        for (const line of lines) {
          const parts = line.split(',');
          if (idxCountry<0 || idxFull<0 || idxEight<0) continue;
          const country = (parts[idxCountry]||'').trim();
          const city = (idxCity>=0 ? (parts[idxCity]||'').trim() : '') || null;
          const full = Number((parts[idxFull]||'0').trim());
          const eight = Number((parts[idxEight]||'0').trim());
          if (country) out.push({ country, city, full_day_eur: full, eight_plus_eur: eight });
        }
        onLoad(out); setPreview(out.slice(0, previewRows));
      } catch (err:any) { alert('Failed to parse dataset: ' + err.message); }
    };
    reader.readAsText(f);
  }
  return (
    <div className="bg-white rounded-2xl shadow p-4">
      <h2 className="font-semibold mb-2">Rates Dataset</h2>
      <p className="text-xs text-gray-600 mb-2">Upload JSON or CSV with columns: country, city (optional), full_day_eur, eight_plus_eur. Saved to this browser.</p>
      <input type="file" accept=".json,.csv" onChange={onFile} />
      {preview && (
        <div className="mt-3">
          <div className="text-xs text-gray-500 mb-1">Preview (first {previewRows} rows):</div>
          <div className="max-h-40 overflow-auto border rounded-lg">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="text-left border-b"><th className="p-1">Country</th><th className="p-1">City</th><th className="p-1">Full</th><th className="p-1">8+ hr</th></tr>
              </thead>
              <tbody>
                {preview.map((r,i)=> (
                  <tr key={i} className="border-b"><td className="p-1">{r.country}</td><td className="p-1">{r.city ?? "All"}</td><td className="p-1">{r.full_day_eur}</td><td className="p-1">{r.eight_plus_eur}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function TripBuilder({ dataset, legs, onAdd, onUpdate, onDelete, countries, citiesFor }: { dataset: DatasetEntry[]; legs: Leg[]; onAdd: (copyPrev?: boolean) => void; onUpdate: (id: string, patch: Partial<Leg>) => void; onDelete: (id: string) => void; countries: string[]; citiesFor: (c:string)=>string[]; }) {
  return (
    <div className="bg-white rounded-2xl shadow p-4">
      <h2 className="font-semibold mb-3">Trip Legs (UTC)</h2>
      <div className="space-y-3">
        {legs.map(l => {
          const cityOptions = citiesFor(l.country);
          return (
            <div key={l.id} className="grid grid-cols-12 gap-2 items-end md:items-center">
              <div className="col-span-3">
                <label className="text-xs">Start (UTC)</label>
                <input type="datetime-local" className="w-full border rounded-xl px-2 py-1" value={l.startUtc} onChange={e=>onUpdate(l.id,{ startUtc: e.target.value })} />
              </div>
              <div className="col-span-3">
                <label className="text-xs">End (UTC)</label>
                <input type="datetime-local" className="w-full border rounded-xl px-2 py-1" value={l.endUtc} onChange={e=>onUpdate(l.id,{ endUtc: e.target.value })} />
              </div>
              <div className="col-span-3">
                <label className="text-xs">Country</label>
                <select className="w-full border rounded-xl px-2 py-1" value={l.country} onChange={e=>{
                  const c = e.target.value; const cityList = citiesFor(c);
                  const nextCity = cityList.includes(l.city || "") ? (l.city || "") : (cityList[0] || "");
                  onUpdate(l.id, { country: c, city: nextCity || null });
                }}>
                  {countries.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <label className="text-xs">City</label>
                <select className="w-full border rounded-xl px-2 py-1" value={l.city || ""} onChange={e=>onUpdate(l.id,{ city: e.target.value || null })}>
                  {cityOptions.map(c => {
                    const label = c ? (c === "Other" ? "Other" : c) : "All"; // empty → All
                    return <option key={c || "__ALL__"} value={c}>{label}</option>;
                  })}
                </select>
              </div>
              <div className="col-span-1" />
              <div className="col-span-1 flex gap-2 justify-end">
                <button className="px-2 py-1 border rounded-xl" onClick={()=>onDelete(l.id)}>Delete</button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap md:flex-nowrap justify-between gap-2">
        <div className="flex gap-2">
          <button className="px-3 py-2 rounded-2xl border" onClick={()=>onAdd(false)}>+ Add Leg</button>
          <button className="px-3 py-2 rounded-2xl border" onClick={()=>onAdd(true)}>⟲ Copy previous</button>
        </div>
        <div className="text-xs text-gray-500">Per‑day rate = from the leg that ENDS on that day.</div>
      </div>
    </div>
  );
}

function ResultsTable({ calc, onToggleBreakfast }: { calc: DayResult[]; onToggleBreakfast: (dateUtc: string, val: boolean) => void }) {
  return (
    <div className="bg-white rounded-2xl shadow p-4">
      <h2 className="font-semibold mb-3">Per‑Diem Breakdown (UTC)</h2>
      <div className="overflow-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left border-b">
              <th className="py-2 pr-4">Date</th>
              <th className="py-2 pr-4">Country/City</th>
              <th className="py-2 pr-4">Hours</th>
              <th className="py-2 pr-4">Band</th>
              <th className="py-2 pr-4">Base</th>
              <th className="py-2 pr-4">Breakfast?</th>
              <th className="py-2 pr-4">Deduction</th>
              <th className="py-2 pr-4">Total</th>
              <th className="py-2">Leg IDs</th>
            </tr>
          </thead>
          <tbody>
            {calc.map(d => {
              const label = `${d.rateRef.country}${d.rateRef.city ? ' — ' + d.rateRef.city : ''}`;
              return (
                <tr key={d.dateUtc} className="border-b">
                  <td className="py-2 pr-4 whitespace-nowrap">{d.dateUtc}</td>
                  <td className="py-2 pr-4">{label || d.rateRef.country}</td>
                  <td className="py-2 pr-4">{d.hours.toFixed(2)}</td>
                  <td className="py-2 pr-4">{d.band}</td>
                  <td className="py-2 pr-4">{formatMoney(d.baseAmount)}</td>
                  <td className="py-2 pr-4">
                    {(d.band === "FULL" || d.band === "HALF") ? (
                      <label className="inline-flex items-center gap-2">
                        <input type="checkbox" checked={d.breakfastTaken} onChange={e=>onToggleBreakfast(d.dateUtc, e.target.checked)} />
                        <span className="text-xs">Taken</span>
                      </label>
                    ) : <span className="text-xs text-gray-400">—</span>}
                  </td>
                  <td className="py-2 pr-4">{d.breakfastDeduction ? `- ${formatMoney(d.breakfastDeduction)}` : "—"}</td>
                  <td className="py-2 pr-4 font-medium">{formatMoney(d.total)}</td>
                  <td className="py-2 text-xs">{d.contributingLegIds.join(", ")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="text-xs text-gray-500 mt-2">Breakfast deduction = 20% of FULL. Applies to HALF and FULL (once per day).</div>
    </div>
  );
}

const ReportPreview = React.forwardRef(function _ReportPreview({ refObj, logoUrl, crewName, empId, reportMonth, calc, total }:{ refObj: React.RefObject<HTMLDivElement>; logoUrl: string; crewName: string; empId: string; reportMonth: string; calc: DayResult[]; total: number; }, _ref:any){
  return (
    <div className="bg-white rounded-2xl shadow p-4" ref={refObj}>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-lg font-semibold">Per‑Diem Report — Windrose Air</div>
          <div className="text-xs text-gray-500">{reportMonth} · Crew: {crewName || "—"} · Employee: {empId || "—"}</div>
        </div>
        {logoUrl ? <img src={logoUrl} alt="logo" className="h-10 object-contain"/> : <div className="text-xs text-gray-400">(Logo)</div>}
      </div>
      <div className="mt-3 overflow-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left border-b">
              <th className="py-2 pr-4">Date</th>
              <th className="py-2 pr-4">Country/City</th>
              <th className="py-2 pr-4">Band</th>
              <th className="py-2 pr-4">Base</th>
              <th className="py-2 pr-4">Breakfast</th>
              <th className="py-2 pr-4">Total</th>
            </tr>
          </thead>
          <tbody>
            {calc.map(d => (
              <tr key={d.dateUtc} className="border-b">
                <td className="py-2 pr-4">{d.dateUtc}</td>
                <td className="py-2 pr-4">{d.rateRef.country}{d.rateRef.city ? ' — ' + d.rateRef.city : ''}</td>
                <td className="py-2 pr-4">{d.band}</td>
                <td className="py-2 pr-4">{formatMoney(d.baseAmount)}</td>
                <td className="py-2 pr-4">{d.breakfastDeduction ? `- ${formatMoney(d.breakfastDeduction)}` : "—"}</td>
                <td className="py-2 pr-4 font-medium">{formatMoney(d.total)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="py-2 pr-4" colSpan={5}><b>Total</b></td>
              <td className="py-2 pr-4 font-semibold">{formatMoney(total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
});

function DevPanel({ onRun, results }: { onRun: () => void; results: TestResult[] | null }) {
  return (
    <div className="bg-white rounded-2xl shadow p-4">
      <h2 className="font-semibold mb-3">Dev Tests</h2>
      <button onClick={onRun} className="px-3 py-2 rounded-2xl border mb-3">Run unit tests</button>
      {results && (
        <div className="space-y-2">
          {results.map((r, i) => (
            <div key={i} className={`text-sm ${r.pass ? 'text-emerald-700' : 'text-red-700'}`}>
              <span className="font-medium">{r.pass ? 'PASS' : 'FAIL'}</span> — {r.name}
              {r.details ? <div className="text-xs text-gray-600">{r.details}</div> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function runDevTests(setTestResults: (v: TestResult[]) => void) {
  const results: TestResult[] = [];

  // T1: HALF base uses eight_plus_eur; breakfast = 20% of full
  {
    const ds: DatasetEntry[] = [ { country: "Testland", city: null, full_day_eur: 100, eight_plus_eur: 60 } ];
    const legs: Leg[] = [{ id: "L1", startUtc: "2025-01-01T00:00", endUtc: "2025-01-01T13:00", country: "Testland", city: null }];
    const res = computePerDiem(legs, ds, { "2025-01-01": true });
    const ok = res.length === 1 && res[0].band === "HALF" && res[0].baseAmount === 60 && res[0].breakfastDeduction === 20 && res[0].total === 40;
    results.push({ name: "HALF uses eight_plus; breakfast 20% of FULL", pass: ok, details: JSON.stringify(res[0]) });
  }

  // T2: FULL base uses full_day_eur; breakfast 20%
  {
    const ds: DatasetEntry[] = [ { country: "X", city: null, full_day_eur: 120, eight_plus_eur: 60 } ];
    const legs: Leg[] = [{ id: "L2", startUtc: "2025-01-02T00:00", endUtc: "2025-01-03T00:00", country: "X", city: null }];
    const res = computePerDiem(legs, ds, { "2025-01-02": true });
    const ok = res.length === 1 && res[0].band === "FULL" && res[0].baseAmount === 120 && res[0].breakfastDeduction === 24 && res[0].total === 96;
    results.push({ name: "FULL uses full; breakfast 20%", pass: ok, details: JSON.stringify(res[0]) });
  }

  // T3: NONE band ignores breakfast
  {
    const ds: DatasetEntry[] = [ { country: "Y", city: null, full_day_eur: 100, eight_plus_eur: 60 } ];
    const legs: Leg[] = [{ id: "L3", startUtc: "2025-01-04T00:00", endUtc: "2025-01-04T07:59", country: "Y", city: null }];
    const res = computePerDiem(legs, ds, { "2025-01-04": true });
    const ok = res.length === 1 && res[0].band === "NONE" && res[0].baseAmount === 0 && res[0].breakfastDeduction === 0 && res[0].total === 0;
    results.push({ name: "NONE ignores breakfast", pass: ok, details: JSON.stringify(res[0]) });
  }

  // T4: Cross‑midnight <24h → single HALF on majority day, breakfast 20%
  {
    const ds: DatasetEntry[] = [ { country: "Z", city: null, full_day_eur: 50, eight_plus_eur: 30 } ];
    const legs: Leg[] = [{ id: "L4", startUtc: "2025-02-01T20:00", endUtc: "2025-02-02T05:00", country: "Z", city: null }];
    const bo = { "2025-02-01": true, "2025-02-02": true } as Record<string, boolean>;
    const res = computePerDiem(legs, ds, bo);
    const d1 = res.find(r => r.dateUtc === "2025-02-01"); const d2 = res.find(r => r.dateUtc === "2025-02-02");
    const ok = d1?.band === "HALF" && d1.baseAmount === 30 && d1.breakfastDeduction === 10 && d1.total === 20 && d2?.band === "NONE" && d2.total === 0;
    results.push({ name: "Cross‑midnight <24h rule with 20% breakfast", pass: !!ok, details: JSON.stringify(res) });
  }

  // T5: Multi‑day (≈50h) ⇒ start/end HALF, middle FULL
  {
    const ds: DatasetEntry[] = [ { country: "M", city: null, full_day_eur: 80, eight_plus_eur: 40 } ];
    const legs: Leg[] = [{ id: "L5", startUtc: "2025-03-01T08:00", endUtc: "2025-03-03T10:00", country: "M", city: null }];
    const res = computePerDiem(legs, ds, { "2025-03-01": true, "2025-03-02": true, "2025-03-03": true });
    const d1 = res.find(r=>r.dateUtc==="2025-03-01"); const d2 = res.find(r=>r.dateUtc==="2025-03-02"); const d3 = res.find(r=>r.dateUtc==="2025-03-03");
    const ok = d1?.band === "HALF" && d2?.band === "FULL" && d3?.band === "HALF";
    results.push({ name: "Multi‑day: HALF/FULL/HALF bands with breakfast allowed", pass: !!ok, details: JSON.stringify(res) });
  }

  // T6: City fallback to "Other" when no explicit city or country‑wide exists
  {
    const ds: DatasetEntry[] = [ { country: "Q", city: "Other", full_day_eur: 70, eight_plus_eur: 35 } ];
    const legs: Leg[] = [{ id: "L6", startUtc: "2025-04-10T09:00", endUtc: "2025-04-10T18:30", country: "Q", city: null }];
    const res = computePerDiem(legs, ds, {});
    const ok = res.length===1 && res[0].band === "HALF" && res[0].baseAmount === 35; // picks Other
    results.push({ name: "Fallback to Other", pass: ok, details: JSON.stringify(res[0]) });
  }

  setTestResults(results);
}

// ---------------- User Bar ----------------

function UserBar({ users, currentEmpId, crewName, onSwitch, onUpsert, onRemove }:{ users: UserProfile[]; currentEmpId: string; crewName: string; onSwitch: (id: string)=>void; onUpsert: (id: string, name: string)=>void; onRemove: (id: string)=>void; }){
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  return (
    <div className="flex items-center gap-2 bg-white border rounded-2xl px-3 py-2 min-w-[220px]">
      <label className="text-xs text-gray-600">Employee</label>
      <select className="text-sm border-0 outline-none" value={currentEmpId} onChange={e => onSwitch(e.target.value)}>
        <option value="">— Select —</option>
        {users.map(u => <option key={u.empId} value={u.empId}>{u.empId} — {u.name}</option>)}
      </select>
      <input className="text-sm border rounded-xl px-2 py-1 w-20 uppercase" maxLength={3} placeholder="ID" value={newId} onChange={e => setNewId(e.target.value.toUpperCase())} />
      <input className="text-sm border rounded-xl px-2 py-1" placeholder="Name" value={newName} onChange={e => setNewName(e.target.value)} />
      <button className="text-sm px-2 py-1 border rounded-xl" onClick={() => onUpsert(newId, newName)}>Save</button>
      {currentEmpId && <button className="text-sm px-2 py-1 border rounded-xl" onClick={() => onRemove(currentEmpId)}>Delete</button>}
    </div>
  );
}
