import React, { useMemo, useRef, useState } from "react";
// PDF export deps (available in canvas runtime)
import jsPDF from "jspdf";
import html2canvas from "html2canvas";

/**
 * Per‑Diem Web App — MVP React Prototype (German rules)
 * ------------------------------------------------------------
 * Implements German per‑diem logic (Verpflegungsmehraufwand):
 * 1) Day basis = calendar days (UTC here; can switch to local later).
 * 2) Thresholds per day:
 *    • FULL: full 24h absence for that calendar day (≈ 24h covered)
 *    • HALF: > 8h and < 24h
 *    • NONE: ≤ 8h
 * 3) Multi‑day trip with overnight (total duration ≥ 24h or covers ≥ 2 midnights):
 *    • First (Anreise) and Last (Abreise) day get HALF (unless FULL applies).
 *    • Intermediate days use thresholds normally.
 * 4) Cross‑midnight WITHOUT overnight (total duration < 24h but spans midnight):
 *    • Sum both days; if total > 8h → ONE HALF on the day with majority of hours; other day NONE.
 * 5) Breakfast deduction: at most once per day; applies only when band is HALF or FULL.
 * 6) Rate per day: use last leg that ends on that day; if none, carry forward last destination.
 * 7) Code mapping precedence: len=3 → IATA, len=4 → ICAO.
 *
 * Also includes:
 * - CSV export fix via buildCsv() helper (proper "\n").
 * - DevPanel with unit tests (updated + new cases).
 * - PDF export with company logo LEFT and report text on the RIGHT, including crew name, month, and employee ID.
 * - NEW: Multi-user support via a three-letter Employee ID list (add/select/delete) stored in localStorage.
 */

// ---------- Types ----------

type Rate = {
  key: string;            // City/Zone key (or IATA-like), e.g., "FRA-City", "MUC-Z2"
  label: string;          // Human label
  perDiemFullEur: number; // Full-day allowance in EUR
  breakfastDeductionEur: number; // Deduction if breakfast taken
};

type Leg = {
  id: string;
  startUtc: string; // ISO (YYYY-MM-DDTHH:mm), treated as UTC
  endUtc: string;   // ISO (YYYY-MM-DDTHH:mm), treated as UTC
  from: string;     // IATA *or* ICAO
  to: string;       // IATA *or* ICAO (destination determines day rate)
  destRateKey: string; // Rate key to apply for days covered by this leg's arrival day
  notes?: string;
};

type DayResult = {
  dateUtc: string;   // YYYY-MM-DD
  rateKey: string;   // which city/zone applies (based on the last leg ending that day)
  hours: number;     // total hours associated with that day (UTC day)
  band: "NONE" | "HALF" | "FULL";
  baseAmount: number; // base amount from rate & band
  breakfastTaken: boolean; // if true, deduct breakfastDeductionEur once
  breakfastDeduction: number; // amount deducted
  total: number; // baseAmount - breakfastDeduction
  contributingLegIds: string[];
};

type TestResult = { name: string; pass: boolean; details?: string };

type UserProfile = { empId: string; name: string }; // three-letter employee ID + display name

// LocalStorage helpers for users
const LS_USERS = "pd_users_v1";
function loadUsers(): UserProfile[] { try { const raw = localStorage.getItem(LS_USERS); if(!raw) return []; const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; } catch { return []; } }
function saveUsers(users: UserProfile[]) { try { localStorage.setItem(LS_USERS, JSON.stringify(users)); } catch {} }

// ---------- Utilities ----------

function isoToDate(d: string): Date {
  // Ensure UTC parsing even for strings without trailing Z
  const needsZ = !/[zZ]$/.test(d);
  return new Date(needsZ ? d + "Z" : d);
}

function ymd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function eachUtcDay(start: Date, end: Date): string[] {
  const days: string[] = [];
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const endDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  const includeEnd = end.getUTCHours() + end.getUTCMinutes() + end.getUTCSeconds() > 0;
  while (cur <= endDay) {
    days.push(ymd(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  if (!includeEnd && days.length) {
    const last = days[days.length - 1];
    if (last === ymd(endDay) && ymd(start) !== ymd(endDay)) days.pop();
  }
  return days;
}

function hoursBetween(a: Date, b: Date) { return (b.getTime() - a.getTime()) / 3_600_000; }

function clampDaySegmentHours(day: string, start: Date, end: Date): number {
  const dayStart = new Date(`${day}T00:00:00Z`);
  const dayEnd = new Date(`${day}T23:59:59Z`);
  let s = start, e = end;
  if (e < dayStart || s > dayEnd) return 0;
  if (s < dayStart) s = dayStart;
  if (e > dayEnd) e = dayEnd;
  return (e.getTime() - s.getTime() + 1000) / 3_600_000;
}

function bandFromHours(h: number) {
  // FULL for a full 24h absence; HALF for >8h and <24h; NONE for ≤8h
  const EPS = 1e-6;
  if (h >= 24 - EPS) return "FULL" as const; // treat 24.0h as FULL
  if (h > 8) return "HALF" as const;
  return "NONE" as const;
}

function formatMoney(n: number) {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(n);
}

function round2(n: number) { return Math.round(n * 100) / 100; }

// CSV builder with proper quoting and line breaks
function buildCsv(header: (string | number | boolean)[], rows: (string | number | boolean)[][]): string {
  const esc = (v: unknown) => `"${String(v).replaceAll('"','""')}"`;
  return [header, ...rows].map(r => r.map(esc).join(",")).join("\n");
}

// ---------- Demo Data (Editable) ----------

const DEFAULT_RATES: Rate[] = [
  { key: "FRA-City", label: "Frankfurt City", perDiemFullEur: 60, breakfastDeductionEur: 8 },
  { key: "MUC", label: "Munich", perDiemFullEur: 58, breakfastDeductionEur: 8 },
  { key: "BER-Z1", label: "Berlin Zone 1", perDiemFullEur: 55, breakfastDeductionEur: 7 },
  { key: "CDG", label: "Paris CDG", perDiemFullEur: 65, breakfastDeductionEur: 9 },
];

// Default mappings for IATA/ICAO → RateKey (editable in UI)
const DEFAULT_IATA_MAP: Record<string, string> = { FRA: "FRA-City", MUC: "MUC", BER: "BER-Z1", CDG: "CDG" };
const DEFAULT_ICAO_MAP: Record<string, string> = { EDDF: "FRA-City", EDDM: "MUC", EDDB: "BER-Z1", LFPG: "CDG" };

// ---------- Main App ----------

export default function App() {
  const [rates, setRates] = useState<Rate[]>(DEFAULT_RATES);
  const [iataMap, setIataMap] = useState<Record<string, string>>(DEFAULT_IATA_MAP);
  const [icaoMap, setIcaoMap] = useState<Record<string, string>>(DEFAULT_ICAO_MAP);
  const [legs, setLegs] = useState<Leg[]>([{
    id: crypto.randomUUID(),
    startUtc: new Date().toISOString().slice(0,16),
    endUtc: new Date(Date.now() + 4*3_600_000).toISOString().slice(0,16),
    from: "FRA",
    to: "EDDM",
    destRateKey: "MUC",
  }]);

  // Users
  const [users, setUsers] = useState<UserProfile[]>(() => loadUsers());
  const [currentEmpId, setCurrentEmpId] = useState<string>(() => (loadUsers()[0]?.empId) || "");

  const [crewName, setCrewName] = useState<string>(loadUsers().find(u => u.empId === (loadUsers()[0]?.empId))?.name || "");
  const [reportMonth, setReportMonth] = useState<string>(new Date().toISOString().slice(0,7)); // YYYY-MM
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const reportRef = useRef<HTMLDivElement | null>(null);

  const [breakfastOverrides, setBreakfastOverrides] = useState<Record<string, boolean>>({}); // dateUtc → breakfastTaken
  const [testResults, setTestResults] = useState<TestResult[] | null>(null);

  const rateMap = useMemo(() => Object.fromEntries(rates.map(r => [r.key, r])), [rates]);

  const calc = useMemo(() => computePerDiem(legs, rateMap, breakfastOverrides), [legs, rateMap, breakfastOverrides]);
  const total = calc.reduce((a, d) => a + d.total, 0);

  function addLeg() {
    const last = legs[legs.length - 1];
    const start = last ? new Date(isoToDate(last.endUtc).getTime() + 60_000) : new Date();
    const end = new Date(start.getTime() + 2 * 3_600_000);
    const to = last?.to || "BER";
    const mapped = mapCodeToRateKey(to, iataMap, icaoMap);
    setLegs(l => [...l, { id: crypto.randomUUID(), startUtc: start.toISOString().slice(0,16), endUtc: end.toISOString().slice(0,16), from: last?.to || "FRA", to, destRateKey: mapped || to }]);
  }

  function updateLeg(id: string, patch: Partial<Leg>) {
    setLegs(ls => ls.map(l => {
      if (l.id !== id) return l;
      const next: Leg = { ...l, ...patch } as Leg;
      if (patch.to !== undefined) {
        const rk = mapCodeToRateKey(patch.to, iataMap, icaoMap);
        if (rk) next.destRateKey = rk;
      }
      return next;
    }));
  }

  function deleteLeg(id: string) { setLegs(ls => ls.filter(l => l.id !== id)); }

  function exportCsv() {
    const header = ["Employee ID","Crew","Month","Date (UTC)", "Rate Key", "Hours", "Band", "Base (EUR)", "Breakfast?", "Breakfast Deduction (EUR)", "Total (EUR)", "Leg IDs"];
    const rows = calc.map(d => [currentEmpId || "", crewName || "", reportMonth, d.dateUtc, d.rateKey, d.hours.toFixed(2), d.band, d.baseAmount.toFixed(2), d.breakfastTaken ? "YES" : "NO", d.breakfastDeduction.toFixed(2), d.total.toFixed(2), d.contributingLegIds.join("|")]);
    const csv = buildCsv(header, rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `per-diem-${currentEmpId || 'EMP'}-${reportMonth}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function exportPdf() {
    const node = reportRef.current;
    if (!node) return;
    // Render the report area to canvas
    const canvas = await html2canvas(node, { scale: 2, useCORS: true, backgroundColor: "#ffffff" });
    const imgData = canvas.toDataURL("image/png");
    const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 36; // 0.5in
    // Fit image width
    const imgWidth = pageWidth - margin * 2;
    const ratio = canvas.height / canvas.width;
    const imgHeight = imgWidth * ratio;
    pdf.addImage(imgData, "PNG", margin, margin, imgWidth, imgHeight);
    // Footer with generation date
    pdf.setFontSize(8);
    pdf.text(`Generated ${new Date().toLocaleString()}`, margin, pageHeight - margin / 2);
    pdf.save(`PerDiem-${reportMonth}.pdf`);
  }

  function onLogoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setLogoDataUrl(String(reader.result));
    reader.readAsDataURL(file);
  }

  // User management helpers
  function upsertUser(empIdRaw: string, name: string) {
    const empId = (empIdRaw || "").toUpperCase().trim();
    if (!/^([A-Z]{3})$/.test(empId)) { alert("Employee ID must be exactly 3 letters (A–Z)"); return; }
    const next = [...loadUsers().filter(u => u.empId !== empId), { empId, name }].sort((a,b)=>a.empId.localeCompare(b.empId));
    setUsers(next); saveUsers(next);
    setCurrentEmpId(empId); setCrewName(name);
  }
  function removeUser(empId: string) {
    const next = loadUsers().filter(u => u.empId !== empId);
    setUsers(next); saveUsers(next);
    if (currentEmpId === empId) { const fallback = next[0]; setCurrentEmpId(fallback?.empId || ""); setCrewName(fallback?.name || ""); }
  }
  function switchUser(empId: string) {
    setCurrentEmpId(empId);
    const u = loadUsers().find(x => x.empId === empId); setCrewName(u?.name || "");
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Toolbar */}
        <header className="flex flex-wrap md:flex-nowrap items-center justify-between gap-3">
          <div className="flex flex-wrap md:flex-nowrap items-center gap-3">
            <UserBar users={Array.isArray(users)? users: []} currentEmpId={currentEmpId} crewName={crewName}
              onSwitch={switchUser} onUpsert={upsertUser} onRemove={removeUser} />
            <div className="flex items-center gap-2 bg-white border rounded-2xl px-3 py-2 min-w-[220px]">
              <label className="text-xs text-gray-600">Month</label>
              <input type="month" className="border-0 outline-none text-sm" value={reportMonth} onChange={e => setReportMonth(e.target.value)} />
            </div>
            <div className="flex items-center gap-2 bg-white border rounded-2xl px-3 py-2 min-w-[220px]">
              <label className="text-xs text-gray-600">Logo</label>
              <input type="file" accept="image/png,image/jpeg" onChange={onLogoFile} className="text-sm" />
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button onClick={exportCsv} className="px-4 py-2 rounded-2xl shadow bg-white border hover:shadow-md">Export CSV</button>
            <button onClick={exportPdf} className="px-4 py-2 rounded-2xl shadow bg-white border hover:shadow-md">Export PDF</button>
          </div>
        </header>

        <section className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <TripBuilder legs={legs} onAdd={addLeg} onUpdate={updateLeg} onDelete={deleteLeg} />
            <ResultsTable calc={calc} rateMap={rateMap} onToggleBreakfast={(dateUtc, val) => setBreakfastOverrides(prev => ({ ...prev, [dateUtc]: val }))} />
          </div>
          <div className="space-y-6">
            <RatesEditor rates={rates} setRates={setRates} />
            <MappingEditor iataMap={iataMap} icaoMap={icaoMap} setIataMap={setIataMap} setIcaoMap={setIcaoMap} />
            <DevPanel onRun={() => runDevTests(setTestResults)} results={testResults} />
          </div>
        </section>

        {/* PDF Report Render Area */}
        <ReportPreview refObj={reportRef} logoDataUrl={logoDataUrl} crewName={crewName} empId={currentEmpId} reportMonth={reportMonth} calc={calc} total={total} rateMap={rateMap} />
      </div>
    </div>
  );
}

// ---------- Components ----------

function RatesEditor({ rates, setRates }: { rates: Rate[]; setRates: (fn: (r: Rate[]) => Rate[]) => void | ((r: Rate[]) => void) | any }) {
  function addRate() { setRates((rs: Rate[]) => [...rs, { key: `NEW-${rs.length+1}`, label: "New City/Zone", perDiemFullEur: 50, breakfastDeductionEur: 8 }]); }
  function update(i: number, patch: Partial<Rate>) { setRates((rs: Rate[]) => rs.map((r, idx) => idx === i ? { ...r, ...patch } : r)); }
  function remove(i: number) { setRates((rs: Rate[]) => rs.filter((_, idx) => idx !== i)); }
  return (
    <div className="bg-white rounded-2xl shadow p-4">
      <h2 className="font-semibold mb-3">City / Zone Rates (EUR)</h2>
      <div className="space-y-3">
        {rates.map((r, i) => (
          <div key={r.key + i} className="grid grid-cols-12 gap-2 items-center">
            <input className="col-span-2 border rounded-xl px-2 py-1" value={r.key} onChange={e => update(i, { key: e.target.value })} />
            <input className="col-span-4 border rounded-xl px-2 py-1" value={r.label} onChange={e => update(i, { label: e.target.value })} />
            <input type="number" className="col-span-3 border rounded-xl px-2 py-1" value={r.perDiemFullEur} onChange={e => update(i, { perDiemFullEur: Number(e.target.value) })} />
            <input type="number" className="col-span-2 border rounded-xl px-2 py-1" value={r.breakfastDeductionEur} onChange={e => update(i, { breakfastDeductionEur: Number(e.target.value) })} />
            <button className="col-span-1 text-sm px-2 py-1 border rounded-xl" onClick={() => remove(i)}>✕</button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <button onClick={addRate} className="px-3 py-2 rounded-2xl border">Add Rate</button>
      </div>
      <div className="text-xs text-gray-500 mt-2">Columns: Key • Label • Full Day (EUR) • Breakfast Deduction (EUR)</div>
    </div>
  );
}

function MappingEditor({ iataMap, icaoMap, setIataMap, setIcaoMap }: { iataMap: Record<string,string>; icaoMap: Record<string,string>; setIataMap: (fn: (m: Record<string,string>)=>Record<string,string>)=>void; setIcaoMap: (fn: (m: Record<string,string>)=>Record<string,string>)=>void; }) {
  const [newIata, setNewIata] = useState("");
  const [newIcao, setNewIcao] = useState("");
  const [newRateKey, setNewRateKey] = useState("");
  return (
    <div className="bg-white rounded-2xl shadow p-4">
      <h2 className="font-semibold mb-3">Code Mapping (IATA / ICAO → Rate Key)</h2>
      <p className="text-xs text-gray-600 mb-3">Example: FRA → FRA-City, EDDF → FRA-City</p>
      <div className="space-y-4">
        <div>
          <h3 className="font-medium mb-2">IATA</h3>
          {Object.entries(iataMap).map(([code, rk]) => (
            <div key={code} className="grid grid-cols-12 gap-2 items-center mb-1">
              <input className="col-span-3 border rounded-xl px-2 py-1" value={code} readOnly />
              <input className="col-span-7 border rounded-xl px-2 py-1" value={rk} onChange={e => setIataMap(m => ({ ...m, [code]: e.target.value }))} />
              <button className="col-span-2 text-sm px-2 py-1 border rounded-xl" onClick={() => setIataMap(m => { const { [code]:_, ...rest } = m; return rest; })}>Delete</button>
            </div>
          ))}
          <div className="grid grid-cols-12 gap-2 items-center mt-2">
            <input className="col-span-3 border rounded-xl px-2 py-1" placeholder="IATA (e.g., FRA)" value={newIata} onChange={e => setNewIata(e.target.value.toUpperCase())} />
            <input className="col-span-7 border rounded-xl px-2 py-1" placeholder="Rate Key (e.g., FRA-City)" value={newRateKey} onChange={e => setNewRateKey(e.target.value)} />
            <button className="col-span-2 text-sm px-2 py-1 border rounded-xl" onClick={() => { if(newIata && newRateKey){ setIataMap(m => ({ ...m, [newIata]: newRateKey })); setNewIata(""); setNewRateKey(""); } }}>Add</button>
          </div>
        </div>
        <div className="pt-3 border-t">
          <h3 className="font-medium mb-2">ICAO</h3>
          {Object.entries(icaoMap).map(([code, rk]) => (
            <div key={code} className="grid grid-cols-12 gap-2 items-center mb-1">
              <input className="col-span-3 border rounded-xl px-2 py-1" value={code} readOnly />
              <input className="col-span-7 border rounded-xl px-2 py-1" value={rk} onChange={e => setIcaoMap(m => ({ ...m, [code]: e.target.value }))} />
              <button className="col-span-2 text-sm px-2 py-1 border rounded-xl" onClick={() => setIcaoMap(m => { const { [code]:_, ...rest } = m; return rest; })}>Delete</button>
            </div>
          ))}
          <div className="grid grid-cols-12 gap-2 items-center mt-2">
            <input className="col-span-3 border rounded-xl px-2 py-1" placeholder="ICAO (e.g., EDDF)" value={newIcao} onChange={e => setNewIcao(e.target.value.toUpperCase())} />
            <input className="col-span-7 border rounded-xl px-2 py-1" placeholder="Rate Key (e.g., FRA-City)" value={newRateKey} onChange={e => setNewRateKey(e.target.value)} />
            <button className="col-span-2 text-sm px-2 py-1 border rounded-xl" onClick={() => { if(newIcao && newRateKey){ setIcaoMap(m => ({ ...m, [newIcao]: newRateKey })); setNewIcao(""); setNewRateKey(""); } }}>Add</button>
          </div>
        </div>
      </div>
      <div className="text-xs text-gray-500 mt-3">Tip: Destination rate key auto-fills when you change a leg's TO code.</div>
    </div>
  );
}

function TripBuilder({ legs, onAdd, onUpdate, onDelete }: { legs: Leg[]; onAdd: () => void; onUpdate: (id: string, patch: Partial<Leg>) => void; onDelete: (id: string) => void; }) {
  return (
    <div className="bg-white rounded-2xl shadow p-4">
      <h2 className="font-semibold mb-3">Trip Legs (UTC)</h2>
      <div className="space-y-4">
        {legs.map((l) => (
          <div key={l.id} className="grid grid-cols-12 gap-2 items-end md:items-center">
            <div className="col-span-3">
              <label className="text-xs">Start (UTC)</label>
              <input type="datetime-local" className="w-full border rounded-xl px-2 py-1" value={l.startUtc} onChange={e => onUpdate(l.id, { startUtc: e.target.value })} />
            </div>
            <div className="col-span-3">
              <label className="text-xs">End (UTC)</label>
              <input type="datetime-local" className="w-full border rounded-xl px-2 py-1" value={l.endUtc} onChange={e => onUpdate(l.id, { endUtc: e.target.value })} />
            </div>
            <div className="col-span-2">
              <label className="text-xs">From (IATA/ICAO)</label>
              <input className="w-full border rounded-xl px-2 py-1" value={l.from} onChange={e => onUpdate(l.id, { from: e.target.value.toUpperCase() })} />
            </div>
            <div className="col-span-2">
              <label className="text-xs">To (IATA/ICAO)</label>
              <input className="w-full border rounded-xl px-2 py-1" value={l.to} onChange={e => onUpdate(l.id, { to: e.target.value.toUpperCase() })} />
            </div>
            <div className="col-span-1">
              <label className="text-xs">Rate Key</label>
              <input className="w-full border rounded-xl px-2 py-1" value={l.destRateKey} onChange={e => onUpdate(l.id, { destRateKey: e.target.value })} />
            </div>
            <div className="col-span-1 flex gap-2 justify-end">
              <button className="px-2 py-1 border rounded-xl" onClick={() => onDelete(l.id)}>Delete</button>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap md:flex-nowrap justify-between gap-2">
        <button onClick={onAdd} className="px-3 py-2 rounded-2xl border">+ Add Leg</button>
        <div className="text-xs text-gray-500">Rate per day = last leg that ENDS on that day.</div>
      </div>
    </div>
  );
}

function ResultsTable({ calc, rateMap, onToggleBreakfast }: { calc: DayResult[]; rateMap: Record<string, Rate>; onToggleBreakfast: (dateUtc: string, val: boolean) => void }) {
  return (
    <div className="bg-white rounded-2xl shadow p-4">
      <h2 className="font-semibold mb-3">Per‑Diem Breakdown (by UTC day)</h2>
      <div className="overflow-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left border-b">
              <th className="py-2 pr-4">Date (UTC)</th>
              <th className="py-2 pr-4">City/Zone</th>
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
            {calc.map((d) => {
              const r = rateMap[d.rateKey];
              return (
                <tr key={d.dateUtc} className="border-b">
                  <td className="py-2 pr-4 whitespace-nowrap">{d.dateUtc}</td>
                  <td className="py-2 pr-4">{r ? `${r.label} (${d.rateKey})` : d.rateKey}</td>
                  <td className="py-2 pr-4">{d.hours.toFixed(2)}</td>
                  <td className="py-2 pr-4">{d.band}</td>
                  <td className="py-2 pr-4">{formatMoney(d.baseAmount)}</td>
                  <td className="py-2 pr-4">
                    {(d.band === "FULL" || d.band === "HALF") ? (
                      <label className="inline-flex items-center gap-2">
                        <input type="checkbox" checked={d.breakfastTaken} onChange={e => onToggleBreakfast(d.dateUtc, e.target.checked)} />
                        <span className="text-xs">Taken</span>
                      </label>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
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
      <div className="text-xs text-gray-500 mt-2">Breakfast deduction applies at most once per day and only if band is HALF or FULL.</div>
    </div>
  );
}

function Summary({ total }: { total: number }) {
  return (
    <div className="bg-white rounded-2xl shadow p-4 flex items-center justify-between">
      <div className="text-lg">Total reimbursement:</div>
      <div className="text-2xl font-semibold">{formatMoney(total)}</div>
    </div>
  );
}

function ReportPreview({ refObj, logoDataUrl, crewName, empId, reportMonth, calc, total, rateMap }:{ refObj: React.RefObject<HTMLDivElement>; logoDataUrl: string | null; crewName: string; empId: string; reportMonth: string; calc: DayResult[]; total: number; rateMap: Record<string,Rate>; }) {
  return (
    <div ref={refObj} className="bg-white rounded-2xl shadow p-6">
      {/* Header with logo LEFT and text RIGHT */}
      <div className="flex items-center gap-6">
        <div className="shrink-0">
          {logoDataUrl ? (
            <img src={logoDataUrl} alt="Company Logo" className="h-12 object-contain" />
          ) : (
            <div className="h-12 w-40 bg-gray-100 rounded flex items-center justify-center text-xs text-gray-500">Upload Logo</div>
          )}
        </div>
        <div className="flex-1">
          <div className="text-xl font-semibold">Per Diem Report — Windrose Air</div>
          <div className="text-sm text-gray-600">{crewName || "Crew Name"} ({empId || "EMP"}) — {reportMonth}</div>
          <div className="text-xs text-gray-400">Generated {new Date().toLocaleDateString()}</div>
        </div>
      </div>
      <div className="mt-4 border-t pt-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b">
              <th className="py-2 pr-4">Date (UTC)</th>
              <th className="py-2 pr-4">City/Zone</th>
              <th className="py-2 pr-4">Hours</th>
              <th className="py-2 pr-4">Band</th>
              <th className="py-2 pr-4">Base</th>
              <th className="py-2 pr-4">Breakfast</th>
              <th className="py-2 pr-4">Deduction</th>
              <th className="py-2 pr-4">Total</th>
            </tr>
          </thead>
          <tbody>
            {calc.map((d) => {
              const r = rateMap[d.rateKey];
              return (
                <tr key={d.dateUtc} className="border-b">
                  <td className="py-2 pr-4 whitespace-nowrap">{d.dateUtc}</td>
                  <td className="py-2 pr-4">{r ? `${r.label} (${d.rateKey})` : d.rateKey}</td>
                  <td className="py-2 pr-4">{d.hours.toFixed(2)}</td>
                  <td className="py-2 pr-4">{d.band}</td>
                  <td className="py-2 pr-4">{formatMoney(d.baseAmount)}</td>
                  <td className="py-2 pr-4">{d.breakfastTaken ? "Yes" : "No"}</td>
                  <td className="py-2 pr-4">{d.breakfastDeduction ? `- ${formatMoney(d.breakfastDeduction)}` : "—"}</td>
                  <td className="py-2 pr-4 font-medium">{formatMoney(d.total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="flex justify-end mt-4 text-lg font-semibold">Total: {formatMoney(total)}</div>
      </div>
    </div>
  );
}

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

// ---------- User Bar ----------
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

// ---------- Calculation Engine ----------

function mapCodeToRateKey(code: string, iataMap: Record<string,string>, icaoMap: Record<string,string>): string | undefined {
  const c = (code || "").toUpperCase().trim();
  if (c.length === 3) return iataMap[c];
  if (c.length === 4) return icaoMap[c];
  return undefined;
}

function computePerDiem(legs: Leg[], rateMap: Record<string, Rate>, breakfastOverrides: Record<string, boolean>): DayResult[] {
  if (!legs.length) return [];

  const norm = legs.map(l => ({ ...l, s: isoToDate(l.startUtc), e: isoToDate(l.endUtc) }))
                   .sort((a,b) => a.s.getTime() - b.s.getTime());

  // Trip envelope
  const tripStart = norm[0].s;
  const tripEnd = norm[norm.length - 1].e;
  const crossesMidnight = ymd(tripStart) !== ymd(tripEnd);
  const tripHours = hoursBetween(tripStart, tripEnd);

  // Build per‑day hours and rate anchors
  const dayHours = new Map<string, { hours: number; legIds: string[] }>();
  const dayLastLegRateKey = new Map<string, string>();

  for (const l of norm) {
    const days = eachUtcDay(l.s, l.e);
    for (const d of days) {
      const h = clampDaySegmentHours(d, l.s, l.e);
      if (h <= 0) continue;
      const rec = dayHours.get(d) || { hours: 0, legIds: [] };
      rec.hours += h;
      if (!rec.legIds.includes(l.id)) rec.legIds.push(l.id);
      dayHours.set(d, rec);
      if (ymd(l.e) === d) dayLastLegRateKey.set(d, l.destRateKey || l.to);
    }
  }

  // Special case: cross‑midnight but total duration < 24h → single HALF on majority day if total > 8h
  if (crossesMidnight && tripHours < 24 - 1e-6) {
    const sortedDays = Array.from(dayHours.keys()).sort();
    if (sortedDays.length === 2) {
      const [d1, d2] = sortedDays;
      const h1 = dayHours.get(d1)?.hours || 0;
      const h2 = dayHours.get(d2)?.hours || 0;
      const total = h1 + h2;
      const majority = h1 >= h2 ? d1 : d2;

      const results: DayResult[] = [];
      for (const d of sortedDays) {
        const rk = dayLastLegRateKey.get(d) || inferFallbackRateKey(norm, d);
        const rate = rateMap[rk];
        let band: "NONE" | "HALF" | "FULL" = "NONE";
        if (total > 8) band = (d === majority) ? "HALF" : "NONE";
        const base = band === "FULL" ? (rate?.perDiemFullEur || 0) : band === "HALF" ? (rate?.perDiemFullEur || 0)/2 : 0;
        const breakfastTaken = !!breakfastOverrides[d];
        const breakfastDeduction = (breakfastTaken && (band === "FULL" || band === "HALF")) ? (rate?.breakfastDeductionEur || 0) : 0;
        results.push({ dateUtc: d, rateKey: rk, hours: round2(dayHours.get(d)?.hours || 0), band, baseAmount: round2(base), breakfastTaken, breakfastDeduction: round2(breakfastDeduction), total: round2(base - breakfastDeduction), contributingLegIds: dayHours.get(d)?.legIds || [] });
      }
      return results.sort((a,b) => a.dateUtc.localeCompare(b.dateUtc));
    }
  }

  // Normal German logic (multi‑day with overnight OR single‑day)
  const daysSorted = Array.from(dayHours.keys()).sort();
  const multiDay = daysSorted.length >= 2 && tripHours >= 24 - 1e-6; // treat ≥24h as overnight trip
  const firstDay = daysSorted[0];
  const lastDay = daysSorted[daysSorted.length - 1];

  const results: DayResult[] = [];

  for (const d of daysSorted) {
    const hrs = dayHours.get(d)?.hours || 0;
    const rk = dayLastLegRateKey.get(d) || inferFallbackRateKey(norm, d);
    const rate = rateMap[rk];

    const fullDay = hrs >= 24 - 1e-6;
    let band: "NONE" | "HALF" | "FULL" = "NONE";

    if (fullDay) band = "FULL";
    else if (multiDay && (d === firstDay || d === lastDay)) band = "HALF"; // An- & Abreisetag
    else if (hrs > 8) band = "HALF";
    else band = "NONE";

    const base = band === "FULL" ? (rate?.perDiemFullEur || 0) : band === "HALF" ? (rate?.perDiemFullEur || 0)/2 : 0;
    const breakfastTaken = !!breakfastOverrides[d];
    const breakfastDeduction = (breakfastTaken && (band === "FULL" || band === "HALF")) ? (rate?.breakfastDeductionEur || 0) : 0;

    results.push({ dateUtc: d, rateKey: rk, hours: round2(hrs), band, baseAmount: round2(base), breakfastTaken, breakfastDeduction: round2(breakfastDeduction), total: round2(base - breakfastDeduction), contributingLegIds: dayHours.get(d)?.legIds || [] });
  }

  return results;
}

function inferFallbackRateKey(legs: (Leg & { s: Date; e: Date; })[], day: string): string {
  // If no leg ended on that day, pick the last known destination before (or first if none)
  let candidate = legs[0]?.destRateKey || legs[0]?.to || "";
  const dayEnd = new Date(`${day}T23:59:59Z`).getTime();
  for (const l of legs) { if (l.e.getTime() <= dayEnd) candidate = l.destRateKey || l.to; }
  return candidate;
}

// ---------- Tests ----------

function runDevTests(setTestResults: (v: TestResult[]) => void) {
  const results: TestResult[] = [];

  // Test 1: CSV newline and quoting
  {
    const h = ["A", "B"]; const r = [["x,y", 'q"w', true], [1, 2, 3]] as (string|number|boolean)[][];
    const csv = buildCsv(h, r); const lines = csv.split("\n"); const correctLines = 1 + r.length; const hasEscapedQuotes = csv.includes('"q""w"');
    results.push({ name: "CSV builder: newline + quoting", pass: lines.length === correctLines && hasEscapedQuotes, details: `lines=${lines.length}, expected=${correctLines}, escapedQuotes=${hasEscapedQuotes}` });
  }

  // Test 2: band thresholds (NONE ≤8, HALF >8 & <24, FULL = 24)
  {
    const t1 = bandFromHours(8) === "NONE"; const t2 = bandFromHours(8.01) === "HALF"; const t3 = bandFromHours(23.99) === "HALF"; const t4 = bandFromHours(24.0) === "FULL";
    results.push({ name: "Thresholds", pass: t1 && t2 && t3 && t4, details: `t1=${t1}, t2=${t2}, t3=${t3}, t4=${t4}`});
  }

  // Test 3: code mapping
  {
    const iata = { FRA: "FRA-City" }; const icao = { EDDF: "FRA-City" };
    const a = mapCodeToRateKey("FRA", iata, icao) === "FRA-City"; const b = mapCodeToRateKey("eddf", iata, icao) === "FRA-City"; const c = mapCodeToRateKey("ABCDE", iata, icao) === undefined;
    results.push({ name: "Mapping: IATA/ICAO", pass: a && b && c, details: `a=${a}, b=${b}, c=${c}`});
  }

  // Test 4: HALF (13h) with breakfast → base is half, then deduct
  {
    const rates: Rate[] = [ { key: "MUC", label: "Munich", perDiemFullEur: 58, breakfastDeductionEur: 8 } ];
    const rmap = Object.fromEntries(rates.map(r => [r.key, r]));
    const legs: Leg[] = [{ id: "L1", startUtc: "2025-01-01T00:00", endUtc: "2025-01-01T13:00", from: "FRA", to: "EDDM", destRateKey: "MUC" }];
    const bo: Record<string, boolean> = { "2025-01-01": true };
    const res = computePerDiem(legs, rmap, bo);
    const expectedBase = 58/2; const ok = res.length === 1 && res[0].band === "HALF" && res[0].baseAmount === expectedBase && res[0].breakfastDeduction === 8 && res[0].total === expectedBase - 8;
    results.push({ name: "Calc: HALF (13h) + breakfast", pass: ok, details: JSON.stringify(res[0]) });
  }

  // Test 5: FULL day (exact 24h) with breakfast → full base then deduct
  {
    const rates: Rate[] = [ { key: "MUC", label: "Munich", perDiemFullEur: 58, breakfastDeductionEur: 8 } ]; const rmap = Object.fromEntries(rates.map(r => [r.key, r]));
    const legs: Leg[] = [{ id: "L2", startUtc: "2025-01-02T00:00", endUtc: "2025-01-03T00:00", from: "EDDF", to: "EDDM", destRateKey: "MUC" }];
    const bo: Record<string, boolean> = { "2025-01-02": true };
    const res = computePerDiem(legs, rmap, bo);
    const ok = res.length === 1 && res[0].band === "FULL" && res[0].baseAmount === 58 && res[0].breakfastDeduction === 8 && res[0].total === 50;
    results.push({ name: "Calc: FULL (24h) + breakfast", pass: ok, details: JSON.stringify(res[0]) });
  }

  // Test 6: fallback rate key carry-forward
  {
    const rates: Rate[] = [ { key: "CDG", label: "Paris CDG", perDiemFullEur: 65, breakfastDeductionEur: 9 } ]; const rmap = Object.fromEntries(rates.map(r => [r.key, r]));
    const legs: Leg[] = [{ id: "L3", startUtc: "2025-02-01T22:00", endUtc: "2025-02-02T02:00", from: "EDDF", to: "LFPG", destRateKey: "CDG" }];
    const res = computePerDiem(legs, rmap, {}); const d1 = res.find(x => x.dateUtc === "2025-02-01"); const d2 = res.find(x => x.dateUtc === "2025-02-02");
    const ok = !!d1 && !!d2 && d1.rateKey === "CDG" && d2.rateKey === "CDG"; results.push({ name: "Fallback rate key carry-forward", pass: !!ok, details: JSON.stringify(res) });
  }

  // Test 7: breakfast override should not deduct on NONE band
  {
    const rates: Rate[] = [ { key: "BER-Z1", label: "Berlin Zone 1", perDiemFullEur: 55, breakfastDeductionEur: 7 } ]; const rmap = Object.fromEntries(rates.map(r => [r.key, r]));
    const legs: Leg[] = [{ id: "L4", startUtc: "2025-03-10T08:00", endUtc: "2025-03-10T15:00", from: "EDDM", to: "EDDB", destRateKey: "BER-Z1" }];
    const bo: Record<string, boolean> = { "2025-03-10": true }; const res = computePerDiem(legs, rmap, bo);
    const ok = res.length === 1 && res[0].band === "NONE" && res[0].breakfastDeduction === 0 && res[0].total === 0; results.push({ name: "Breakfast on NONE should be ignored", pass: ok, details: JSON.stringify(res[0]) });
  }

  // Test 8: cross‑midnight without overnight (<24h) → ONE HALF on majority day
  {
    const rates: Rate[] = [ { key: "MUC", label: "Munich", perDiemFullEur: 58, breakfastDeductionEur: 8 } ]; const rmap = Object.fromEntries(rates.map(r => [r.key, r]));
    const legs: Leg[] = [{ id: "L5", startUtc: "2025-04-01T20:00", endUtc: "2025-04-02T05:00", from: "EDDF", to: "EDDM", destRateKey: "MUC" }];
    const res = computePerDiem(legs, rmap, {}); const d1 = res.find(x => x.dateUtc === "2025-04-01"); const d2 = res.find(x => x.dateUtc === "2025-04-02");
    const ok = d1?.band === "HALF" && d2?.band === "NONE" && res.length === 2; results.push({ name: "Cross‑midnight <24h → one HALF on majority day", pass: !!ok, details: JSON.stringify(res) });
  }

  // Test 9: multi‑day with overnight (≥24h): first & last HALF, middle FULL
  {
    const rates: Rate[] = [ { key: "CDG", label: "Paris CDG", perDiemFullEur: 60, breakfastDeductionEur: 9 } ]; const rmap = Object.fromEntries(rates.map(r => [r.key, r]));
    const legs: Leg[] = [{ id: "L6", startUtc: "2025-05-01T10:00", endUtc: "2025-05-03T14:00", from: "EDDF", to: "LFPG", destRateKey: "CDG" }];
    const res = computePerDiem(legs, rmap, {}); const d1 = res.find(x => x.dateUtc === "2025-05-01"); const d2 = res.find(x => x.dateUtc === "2025-05-02"); const d3 = res.find(x => x.dateUtc === "2025-05-03");
    const ok = d1?.band === "HALF" && d2?.band === "FULL" && d3?.band === "HALF"; results.push({ name: "Overnight: first/last HALF, middle FULL", pass: !!ok, details: JSON.stringify(res) });
  }

  // Test 10: Employee ID validation (exactly 3 letters)
  {
    const good = /^([A-Z]{3})$/.test("PMZ");
    const bad1 = /^([A-Z]{3})$/.test("PM");
    const bad2 = /^([A-Z]{3})$/.test("PM12");
    results.push({ name: "EmpID: 3-letter validation", pass: good && !bad1 && !bad2, details: `good=${good}, bad1=${bad1}, bad2=${bad2}` });
  }

  setTestResults(results);
}
