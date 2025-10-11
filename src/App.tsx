import React, { useMemo, useRef, useState } from "react";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";

/**
 * Per‑Diem Web App — Country/City Dataset v3.1 (German rules)
 * JSX — sandbox‑safe version
 * ------------------------------------------------------------------
 * Patch notes (fixes syntax error & improves robustness):
 * - Removed stray backslashes before quotes in JSX attributes (e.g., className="...").
 * - Left `import.meta` out; BASE_URL resolver is sandbox‑friendly.
 * - Preserved UI tweaks: top logo row; compact "Data Base" loader button; 5‑minute datetime step; right‑side vertical stack.
 * - Kept CSV regex at /\r?\n/.
 * - Added more console self‑tests without changing existing ones.
 */

// ---------------- Helpers ----------------

function uuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// BASE_URL resolver that does NOT reference `import` or `import.meta`.
// Priority: window.PERDIEM_BASE_URL > <base href> > derive from location > '/'
const BASE_URL = (() => {
  try {
    if (typeof window !== "undefined") {
      if (window.PERDIEM_BASE_URL) return String(window.PERDIEM_BASE_URL);
      const baseEl = (typeof document !== "undefined") && document.querySelector("base[href]");
      if (baseEl) {
        const href = baseEl.getAttribute("href") || "/";
        return href.endsWith("/") ? href : href + "/";
      }
      if (typeof location !== "undefined") {
        // Return current path directory (so fetching relative asset works when app is nested)
        const p = location.pathname;
        return p.endsWith("/") ? p : p.replace(/[^/]*$/, "");
      }
    }
  } catch {}
  return "/";
})();

const DEFAULT_LOGO_URL = BASE_URL + "logo.png";

// ---------------- Utilities ----------------

const ymd = (d) => d.toISOString().slice(0,10);
const isoToDate = (iso) => new Date(iso + (iso.endsWith("Z")?"":"Z"));
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const hoursBetween = (a, b) => (b.getTime() - a.getTime()) / 3_600_000;

function eachUtcDay(start, end){
  const days = [];
  let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const endDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (d.getTime() <= endDay.getTime()) { days.push(ymd(d)); d = new Date(d.getTime() + 86_400_000); }
  return days;
}

function clampDaySegmentHours(day, s, e){
  const dayStart = new Date(day + "T00:00:00Z");
  const dayEnd = new Date(day + "T23:59:59Z");
  const start = Math.max(s.getTime(), dayStart.getTime());
  const end = Math.min(e.getTime(), dayEnd.getTime());
  const ms = Math.max(0, end - start + 1000);
  return ms/3_600_000;
}

function formatMoney(n){ return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(n); }

// ---------------- LocalStorage ----------------

const LS_USERS = "pd_users_v1";
const LS_DATASET = "pd_dataset_v1";

function loadUsers(){ try { const raw = localStorage.getItem(LS_USERS); return raw ? JSON.parse(raw) : []; } catch { return []; } }
function saveUsers(users){ try { localStorage.setItem(LS_USERS, JSON.stringify(users)); } catch {}
}

function loadDataset(){ try { const raw = localStorage.getItem(LS_DATASET); return raw ? JSON.parse(raw) : null; } catch { return null; } }
function saveDataset(ds){ try { localStorage.setItem(LS_DATASET, JSON.stringify(ds)); } catch {}
}

// ---------------- Default dataset ----------------

const DEFAULT_DATASET = [
  { country: "Germany", city: null, full_day_eur: 28, eight_plus_eur: 14 },
  { country: "France", city: "Paris", full_day_eur: 58, eight_plus_eur: 39 },
  { country: "France", city: "Other", full_day_eur: 53, eight_plus_eur: 36 },
  { country: "United Kingdom", city: "London", full_day_eur: 66, eight_plus_eur: 44 },
  { country: "United Kingdom", city: "Other", full_day_eur: 52, eight_plus_eur: 35 },
];

// ---------------- Core calc ----------------

function computePerDiem(legs, dataset, breakfastOverrides){
  if (!legs.length) return [];

  const norm = legs.map(l => ({ ...l, s: isoToDate(l.startUtc), e: isoToDate(l.endUtc) }))
                   .sort((a,b) => a.s.getTime() - b.s.getTime());

  const tripStart = norm[0].s;
  const tripEnd = norm[norm.length - 1].e;
  const crossesMidnight = ymd(tripStart) !== ymd(tripEnd);
  const tripHours = hoursBetween(tripStart, tripEnd);

  function rateFor(country, city){
    let found = dataset.find(d => d.country === country && (d.city || "") === (city || ""));
    if (found) return found;
    found = dataset.find(d => d.country === country && (d.city || "") === "Other");
    if (found) return found;
    return dataset.find(d => d.country === country && d.city === null);
  }

  const dayHours = new Map();
  const dayLastLegSel = new Map();

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

  function buildDayResult(d, hrs){
    const sel = dayLastLegSel.get(d) || { country: norm[0].country, city: norm[0].city };
    const rate = rateFor(sel.country, sel.city || null);
    const full = rate?.full_day_eur ?? 0;
    const halfVal = rate?.eight_plus_eur ?? 0;

    let band = "NONE";
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
      const out = [];
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

  const results = [];
  for (const d of daysSorted) {
    const hrs = dayHours.get(d)?.hours || 0;
    let band = "NONE";
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

export default function App(){
  const stored = loadDataset();
  const [dataset, setDataset] = useState(stored || DEFAULT_DATASET);
  const [dataStatus, setDataStatus] = useState(stored ? "local" : "default");

  // Try to fetch server‑side JSON once (optional)
  React.useEffect(() => {
    (async () => {
      try {
        const res = await fetch(BASE_URL + "per_diem_2025.json", { cache: "no-store" });
        if (res.ok) {
          const j = await res.json();
          const flat = Array.isArray(j)
            ? j
            : (j && j.countries
                ? j.countries.flatMap((c) =>
                    c.entries.map((e) => ({
                      country: c.country,
                      city: e.city ?? null,
                      full_day_eur: Number(e.full_day_eur),
                      eight_plus_eur: Number(e.eight_plus_eur)
                    }))
                  )
                : []);
          if (flat.length) { setDataset(flat); saveDataset(flat); setDataStatus("server"); }
        }
      } catch {}
    })();
  }, []);

  const firstCountry = dataset[0]?.country || "";
  const firstCity = (dataset.find(d => d.country === firstCountry && d.city !== null) || {}).city || null;

  const [legs, setLegs] = useState([{
    id: uuid(),
    startUtc: new Date().toISOString().slice(0,16),
    endUtc: new Date(Date.now()+4*3_600_000).toISOString().slice(0,16),
    country: firstCountry,
    city: firstCity,
  }]);

  const [users, setUsers] = useState(() => loadUsers());
  const [currentEmpId, setCurrentEmpId] = useState(() => (loadUsers()[0]?.empId) || "");
  const [crewName, setCrewName] = useState(loadUsers().find(u => u.empId === (loadUsers()[0]?.empId))?.name || "");
  const [reportMonth, setReportMonth] = useState(new Date().toISOString().slice(0,7));
  const [breakfastOverrides, setBreakfastOverrides] = useState({});
  const [dataStatusState] = useState(dataStatus);
  const reportRef = useRef(null);

  const calc = useMemo(() => computePerDiem(legs, dataset, breakfastOverrides), [legs, dataset, breakfastOverrides]);
  const total = useMemo(() => round2(calc.reduce((a,b) => a + b.total, 0)), [calc]);

  function countries(){ return Array.from(new Set(dataset.map(d => d.country))).sort(); }
  function citiesFor(country){
    const list = dataset.filter(d => d.country === country);
    const cities = Array.from(new Set(list.map(d => (d.city || "")))).sort();
    if (!cities.length) return [""]; // show "All"
    return cities;
  }

  function addLeg(copyPrev=false){
    const last = legs[legs.length - 1];
    const start = last ? new Date(isoToDate(last.endUtc).getTime() + 60_000) : new Date();
    const end = new Date(start.getTime() + 2*3_600_000);
    const c = copyPrev && last ? last.country : (dataset[0]?.country || "");
    const cityList = citiesFor(c);
    const city = copyPrev && last ? last.city : ((cityList[0] || "") || null);
    setLegs(ls => [...ls, { id: uuid(), startUtc: start.toISOString().slice(0,16), endUtc: end.toISOString().slice(0,16), country: c, city }]);
  }
  function updateLeg(id, patch){ setLegs(ls => ls.map(l => l.id === id ? { ...l, ...patch } : l)); }
  function deleteLeg(id){ setLegs(ls => ls.filter(l => l.id !== id)); }

  function exportCSV(){
    const header = ["Employee ID","Crew","Month","Date (UTC)", "Country","City","Hours", "Band", "Base (EUR)", "Breakfast?", "Breakfast Deduction (EUR)", "Total (EUR)", "Leg IDs" ];
    const rows = calc.map(d => [currentEmpId || "", crewName || "", reportMonth, d.dateUtc, d.rateRef.country, d.rateRef.city || "", d.hours.toFixed(2), d.band, d.baseAmount.toFixed(2), d.breakfastTaken ? "YES" : "NO", d.breakfastDeduction.toFixed(2), d.total.toFixed(2), d.contributingLegIds.join("|")]);
    const esc = (v) => `"${String(v).replaceAll('"','""')}"`;
    const csv = [header, ...rows].map(r => r.map(esc).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `per_diem_${reportMonth}.csv`; a.click(); URL.revokeObjectURL(url);
  }

  async function exportPdf(){
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
  function upsertUser(empIdRaw, name){
    const empId = (empIdRaw || "").toUpperCase().trim();
    if (!/^([A-Z]{3})$/.test(empId)) { alert("Employee ID must be exactly 3 letters (A–Z)"); return; }
    const next = [...loadUsers().filter(u => u.empId !== empId), { empId, name }].sort((a,b)=>a.empId.localeCompare(b.empId));
    setUsers(next); saveUsers(next);
  }
  function removeUser(empId){ const next = loadUsers().filter(u => u.empId !== empId); setUsers(next); saveUsers(next); if (currentEmpId === empId) { const f = next[0]; setCurrentEmpId(f?.empId || ""); setCrewName(f?.name || ""); } }
  function switchUser(empId){ setCurrentEmpId(empId); const u = loadUsers().find(x => x.empId === empId); setCrewName(u?.name || ""); }

  const ratesBadge = (() => { const label = dataStatus==="server"?"rates: server": dataStatus==="uploaded"?"rates: uploaded": dataStatus==="local"?"rates: saved": "rates: default"; const cls = dataStatus==="server"?"bg-emerald-100 text-emerald-700": dataStatus==="uploaded"?"bg-blue-100 text-blue-700": dataStatus==="local"?"bg-amber-100 text-amber-700":"bg-gray-100 text-gray-700"; return <span className={`text-[10px] px-2 py-1 rounded-full ${cls}`}>{label}</span>; })();

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Top logo row */}
        <div className="flex items-center justify-between">
          <img src={DEFAULT_LOGO_URL} alt="Logo" className="h-10 md:h-12 object-contain" />
        </div>
        {/* Toolbar */}
        <header className="flex flex-wrap md:flex-nowrap items-center justify-between gap-3">
          <div className="flex flex-wrap md:flex-nowrap items-center gap-3">
            <UserBar users={users} currentEmpId={currentEmpId} crewName={crewName}
              onSwitch={switchUser} onUpsert={upsertUser} onRemove={removeUser} />
            <div className="flex items-center gap-2 bg-white border rounded-2xl px-3 py-2 min-w-[220px]">
              <label className="text-xs text-gray-600">Month</label>
              <input type="month" className="border-0 outline-none text-sm" value={reportMonth} onChange={e => setReportMonth(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            <div className="flex items-center gap-2">
              <DatasetLoader onLoad={(d)=>{ setDataset(d); saveDataset(d); setDataStatus("uploaded"); }} previewRows={0} compact />
              {ratesBadge}
            </div>
            <div className="flex items-center gap-3">
              <button onClick={exportCSV} className="px-4 py-2 rounded-2xl shadow bg-white border hover:shadow-md">Export CSV</button>
              <button onClick={exportPdf} className="px-4 py-2 rounded-2xl shadow bg-white border hover:shadow-md">Export PDF</button>
            </div>
          </div>
        </header>

        <section className="space-y-6">
          <TripBuilder dataset={dataset} legs={legs} onAdd={addLeg} onUpdate={updateLeg} onDelete={deleteLeg} countries={countries()} citiesFor={citiesFor} />
          <ResultsTable calc={calc} onToggleBreakfast={(dateUtc, val)=>setBreakfastOverrides(p=>({ ...p, [dateUtc]: val }))} />
        </section>

        <ReportPreview refObj={reportRef} crewName={crewName} empId={currentEmpId} reportMonth={reportMonth} calc={calc} total={total} />
      </div>
    </div>
  );
}

// ---------------- Components ----------------

function DatasetLoader({ onLoad, previewRows = 5, compact = false }){
  const [preview, setPreview] = useState(null);
  const fileRef = useRef(null);

  function onFile(e){
    const f = e.target.files?.[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const txt = String(reader.result || "");
      try {
        if (f.name.toLowerCase().endsWith('.json')) {
          const json = JSON.parse(txt);
          const flat = [];
          if (Array.isArray(json)) {
            for (const r of json) flat.push({ country: r.country, city: r.city ?? null, full_day_eur: Number(r.full_day_eur), eight_plus_eur: Number(r.eight_plus_eur) });
          } else if (json && json.countries) {
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
        const out = [];
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
      } catch (err) { alert('Failed to parse dataset: ' + (err && err.message ? err.message : String(err))); }
    };
    reader.readAsText(f);
  }

  if (compact) {
    return (
      <div className="">
        <input ref={fileRef} type="file" accept=".json,.csv" onChange={onFile} className="hidden" />
        <button className="px-3 py-2 rounded-2xl border bg-white hover:shadow text-sm" onClick={() => fileRef.current && fileRef.current.click()}>Data Base</button>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl shadow p-4">
      <h2 className="font-semibold mb-2">Rates Dataset</h2>
      <input type="file" accept=".json,.csv" onChange={onFile} />
      {preview && previewRows>0 && (
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

function TripBuilder({ dataset, legs, onAdd, onUpdate, onDelete, countries, citiesFor }){
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
                <input type="datetime-local" step={300} className="w-full border rounded-xl px-2 py-1" value={l.startUtc} onChange={e=>onUpdate(l.id,{ startUtc: e.target.value })} />
              </div>
              <div className="col-span-3">
                <label className="text-xs">End (UTC)</label>
                <input type="datetime-local" step={300} className="w-full border rounded-xl px-2 py-1" value={l.endUtc} onChange={e=>onUpdate(l.id,{ endUtc: e.target.value })} />
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

function ResultsTable({ calc, onToggleBreakfast }){
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

function ReportPreview({ refObj, crewName, empId, reportMonth, calc, total }){
  return (
    <div className="bg-white rounded-2xl shadow p-4" ref={refObj}>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-lg font-semibold">Per‑Diem Report — Windrose Air</div>
          <div className="text-xs text-gray-500">{reportMonth} · Crew: {crewName || "—"} · Employee: {empId || "—"}</div>
        </div>
        {DEFAULT_LOGO_URL ? <img src={DEFAULT_LOGO_URL} alt="logo" className="h-10 object-contain"/> : <div className="text-xs text-gray-400">(Logo)</div>}
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
}

function UserBar({ users, currentEmpId, crewName, onSwitch, onUpsert, onRemove }){
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

// ---------------- Self‑tests (console only, no UI) ----------------
(function runSelfTests(){
  try {
    const T = (name, fn) => { try { fn(); console.log("✅", name); } catch (e) { console.error("❌", name, e); } };
    const assert = (cond, msg) => { if (!cond) throw new Error(msg || "Assertion failed"); };

    const ds = DEFAULT_DATASET; // Germany full 28 / 8+ is 14

    // Existing tests
    T("Same‑day >8h → HALF", () => {
      const legs = [{ id: "a", startUtc: "2025-01-01T08:00", endUtc: "2025-01-01T18:00", country: "Germany", city: null }];
      const out = computePerDiem(legs, ds, {});
      assert(out.length === 1, "1 day expected");
      assert(out[0].band === "HALF", "HALF expected");
      assert(out[0].baseAmount === 14, "Base 14 EUR expected");
    });

    T("Cross‑midnight ==8h total → NONE", () => {
      const legs = [{ id: "b", startUtc: "2025-01-01T22:00", endUtc: "2025-01-02T06:00", country: "Germany", city: null }];
      const out = computePerDiem(legs, ds, {});
      const sum = out.reduce((a,b)=>a+b.baseAmount,0);
      assert(sum === 0, "No allowance when total == 8h");
    });

    T("Cross‑midnight 10h → HALF on majority day", () => {
      const legs = [{ id: "c", startUtc: "2025-01-01T21:00", endUtc: "2025-01-02T07:00", country: "Germany", city: null }];
      const out = computePerDiem(legs, ds, {});
      const bands = out.map(x=>x.band);
      assert(bands.includes("HALF"), "One HALF expected");
      assert(bands.filter(b=>b==="HALF").length === 1, "Only one HALF expected");
    });

    T("Multi‑day >=24h → HALF/FULL/HALF pattern", () => {
      const legs = [{ id: "d", startUtc: "2025-01-01T10:00", endUtc: "2025-01-03T12:00", country: "Germany", city: null }];
      const out = computePerDiem(legs, ds, {});
      const bands = out.map(x=>x.band);
      assert(bands[0] === "HALF" && bands[bands.length-1] === "HALF", "Start/End should be HALF");
      assert(bands.includes("FULL"), "Middle day should be FULL");
    });

    T("Breakfast deduction = 20% of FULL", () => {
      const legs = [{ id: "e", startUtc: "2025-01-05T08:00", endUtc: "2025-01-05T18:00", country: "Germany", city: null }];
      const out = computePerDiem(legs, ds, { "2025-01-05": true });
      assert(out[0].band === "HALF", "HALF expected");
      assert(out[0].breakfastDeduction === 5.6, "20% of 28 = 5.6");
      assert(out[0].total === 8.4, "14 - 5.6 = 8.4");
    });

    // Additional tests
    T("City fallback to 'Other' works", () => {
      const legs = [{ id: "f", startUtc: "2025-02-01T08:00", endUtc: "2025-02-01T18:30", country: "France", city: "Lyon" }];
      const out = computePerDiem(legs, ds, {});
      assert(out[0].band === "HALF", "HALF expected");
      assert(out[0].baseAmount === 36, "France 'Other' 8+ should be 36");
    });

    T("Null/All city uses country default", () => {
      const legs = [{ id: "g", startUtc: "2025-03-01T08:00", endUtc: "2025-03-01T18:30", country: "Germany", city: "" }];
      const out = computePerDiem(legs, ds, {});
      assert(out[0].band === "HALF", "HALF expected");
      assert(out[0].baseAmount === 14, "Germany 8+ should be 14");
    });

    T("Exactly 24h spanning 2 days → HALF + HALF", () => {
      const legs = [{ id: "h", startUtc: "2025-04-01T00:00", endUtc: "2025-04-02T00:00", country: "Germany", city: null }];
      const out = computePerDiem(legs, ds, {});
      const bands = out.map(x=>x.band);
      assert(bands.length === 2, "Two calendar days");
      assert(bands[0] === "HALF" && bands[1] === "HALF", "Start and end should be HALF for >=24h");
    });

    T("Breakfast on FULL day deducts 20% of correct FULL rate", () => {
      const legs = [{ id: "i", startUtc: "2025-05-01T00:00", endUtc: "2025-05-03T00:00", country: "France", city: "Paris" }];
      const out = computePerDiem(legs, ds, { [outMiddleDate(out)]: true });
      const middle = out.find(r => r.band === "FULL");
      assert(!!middle, "There should be a FULL day");
      assert(middle.breakfastDeduction === round2(58 * 0.2), "20% of 58 = 11.6");
    });

    // New: Same‑day exactly 8h → NONE (current rule uses strictly > 8h)
    T("Same‑day ==8h total → NONE", () => {
      const legs = [{ id: "j", startUtc: "2025-06-01T09:00", endUtc: "2025-06-01T17:00", country: "Germany", city: null }];
      const out = computePerDiem(legs, ds, {});
      const sum = out.reduce((a,b)=>a+b.baseAmount,0);
      assert(sum === 0, "No allowance when total == 8h (same day)");
    });

    // New: Breakfast ticked on a NONE day should not deduct anything
    T("Breakfast on NONE day does not deduct", () => {
      const legs = [{ id: "k", startUtc: "2025-06-02T09:00", endUtc: "2025-06-02T17:00", country: "Germany", city: null }];
      const out = computePerDiem(legs, ds, { "2025-06-02": true });
      assert(out[0].band === "NONE", "NONE expected");
      assert(out[0].breakfastDeduction === 0, "No deduction on NONE day");
      assert(out[0].total === 0, "Total remains 0");
    });

    // New: Last‑leg‑wins per‑day rate selection
    T("Per‑day rate selected by last leg that ends that day", () => {
      const legs = [
        { id: "l1", startUtc: "2025-07-01T06:00", endUtc: "2025-07-01T10:00", country: "France", city: "Paris" },
        { id: "l2", startUtc: "2025-07-01T10:30", endUtc: "2025-07-01T12:00", country: "France", city: "Other" }
      ];
      const out = computePerDiem(legs, ds, {});
      if (out[0].band !== "NONE") {
        // if >8h, logic might differ, so enforce hours small
        console.warn("Test setup note: band is", out[0].band);
      }
      // Even if totals are NONE, the reference should be to the last leg's city
      const ref = out[0].rateRef;
      assert(ref.country === "France" && (ref.city === "Other" || ref.city === "Other"), "Rate ref should use last leg city 'Other'");
    });

    function outMiddleDate(out){
      if (!out || out.length < 3) return "";
      return out[Math.floor(out.length/2)].dateUtc;
    }
  } catch (e) {
    console.error("Self‑tests failed to run:", e);
  }
})();
