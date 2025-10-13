import React, { useEffect, useMemo, useState } from "react";

/**
 * Per‑Diem Web App — Refactor v4.8 (no IATA/ICAO)
 * ---------------------------------------------------------------
 * Fix: Correctly close <CardContent> in Trip Legs section and remove stray,
 * malformed JSX that referenced out-of-scope variables. Clean, one-line leg UI.
 *
 * Keeps: DB loader (flat or nested), secondary base from DB (default none),
 * per‑leg breakfast (in Preview), 1‑minute steps, home‑base rule, sentinel.
 */

// ——— Tiny UI wrappers (Tailwind-only, no external UI lib) ———
function Card(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={"rounded-2xl border shadow-sm bg-white " + (props.className || "")} />;
}
function CardHeader(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={"px-4 pt-4 " + (props.className || "")} />;
}
function CardTitle(props: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 {...props} className={"text-lg font-semibold " + (props.className || "")} />;
}
function CardContent(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={"p-4 " + (props.className || "")} />;
}
function Button({ variant = "default", className = "", ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "outline" | "secondary" }) {
  const base = "inline-flex items-center justify-center rounded-xl px-3 py-2 text-sm font-medium shadow-sm transition";
  const variants: Record<string, string> = {
    default: "bg-black text-white hover:opacity-90",
    outline: "border bg-white hover:bg-neutral-50",
    secondary: "bg-neutral-100 hover:bg-neutral-200",
  };
  return <button {...rest} className={`${base} ${variants[variant]} ${className}`} />;
}
function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`w-full rounded-xl border px-3 py-2 text-sm ${props.className || ""}`} />;
}
function Badge(props: React.HTMLAttributes<HTMLSpanElement>) {
  return <span {...props} className={`inline-flex items-center rounded-full border px-2 py-1 text-xs ${props.className || ""}`} />;
}

// Inline icons (no external deps)
const Icon = (p:any)=> <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p} />;
function IconPlus(props:any){ return <Icon {...props}><path d="M12 5v14"/><path d="M5 12h14"/></Icon>; }
function IconDatabase(props:any){ return <Icon {...props}><ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v14c0 1.66 3.13 3 7 3s7-1.34 7-3V5"/><path d="M5 12c0 1.66 3.13 3 7 3s7-1.34 7-3"/></Icon>; }
function IconDownload(props:any){ return <Icon {...props}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></Icon>; }
function IconEdit(props:any){ return <Icon {...props}><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></Icon>; }

// ——— Types ———
const emptyRates = [] as Array<{
  country: string;
  city?: string | null;
  full_day_eur: number;
  eight_plus_eur: number;
}>;

const defaultEmployees = [
  { id: "BER", name: "Default Pilot", basePrimary: { country: "Germany", city: "Berlin" }, baseSecondary: { country: "", city: "" } },
] as Array<{
  id: string; // 3 letters
  name: string;
  basePrimary: { country: string; city: string };
  baseSecondary?: { country: string; city: string };
}>;

// ——— Constants ———
const CITY_COUNTRY_ONLY_SENTINEL = "__country_only__"; // avoid collisions with real city names
const LS_RATES_KEY = "perdiem_rates_v1"; // localStorage persistence
const DEFAULT_RATE_CANDIDATES = ["./per_diem_2025.json", "/per_diem_2025.json"]; // try relative then root

// ——— Helpers ———
function buildCountryCityMap(rates: typeof emptyRates) {
  const map = new Map<string, Set<string>>();
  for (const r of rates) {
    const ctry = (r.country || "").trim();
    const cty = (r.city ?? "").trim();
    if (!ctry) continue;
    if (!map.has(ctry)) map.set(ctry, new Set<string>());
    if (cty) map.get(ctry)!.add(cty);
  }
  return map; // country -> set(cities)
}

function toCSV(rows: string[][]) {
  return rows
    .map(r =>
      r
        .map(cell => {
          const s = String(cell ?? "");
          return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        })
        .join(",")
    )
    .join("\n");
}

function parseCSV(text: string) {
  // Very small CSV parser for our columns: country,city,full_day_eur,eight_plus_eur
  // Assumes a header row.
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return [] as typeof emptyRates;
  const header = lines[0].split(",").map(h => h.trim().toLowerCase());
  const idx = {
    country: header.indexOf("country"),
    city: header.indexOf("city"),
    full: header.indexOf("full_day_eur"),
    eight: header.indexOf("eight_plus_eur"),
  };
  const out: typeof emptyRates = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = [] as string[];
    let cur = "";
    let inQ = false;
    const row = lines[i];
    for (let j = 0; j < row.length; j++) {
      const ch = row[j];
      if (ch === '"') {
        if (inQ && row[j + 1] === '"') { cur += '"'; j++; }
        else { inQ = !inQ; }
      } else if (ch === "," && !inQ) { cols.push(cur); cur = ""; }
      else cur += ch;
    }
    cols.push(cur);
    const get = (k: number) => (k >= 0 && k < cols.length ? cols[k].trim() : "");
    const country = get(idx.country);
    if (!country) continue;
    out.push({ country, city: (get(idx.city) || null), full_day_eur: Number(get(idx.full) || 0), eight_plus_eur: Number(get(idx.eight) || 0) });
  }
  return out;
}

// New: normalize any supported JSON (flat array OR nested countries[].entries[])
function normalizeRates(jsonData: any): typeof emptyRates {
  // Case A: already a flat array
  if (Array.isArray(jsonData)) {
    return (jsonData as any[]).map(r => ({
      country: String(r?.country || "").trim(),
      city: r?.city == null ? null : String(r.city).trim(),
      full_day_eur: Number(r?.full_day_eur || 0),
      eight_plus_eur: Number(r?.eight_plus_eur || 0),
    })).filter(r => r.country);
  }
  // Case B: nested object with countries[].entries[]
  if (jsonData && Array.isArray(jsonData.countries)) {
    const out: typeof emptyRates = [];
    for (const c of jsonData.countries) {
      const country = String(c?.country || "").trim();
      if (!country) continue;
      const entries = Array.isArray(c?.entries) ? c.entries : [];
      for (const e of entries) {
        out.push({
          country,
          city: e?.city == null ? null : String(e.city).trim(),
          full_day_eur: Number(e?.full_day_eur || 0),
          eight_plus_eur: Number(e?.eight_plus_eur || 0),
        });
      }
    }
    return out.filter(r => r.country);
  }
  // Unknown shape → empty
  return [] as typeof emptyRates;
}

function guessRatesByLocation(rates: typeof emptyRates, country: string, city: string) {
  // 1) country+city exact
  const exact = rates.find(r => r.country === country && (r.city || "") === (city || ""));
  if (exact) return exact;
  // 2) country-only fallback (city empty/null in dataset or labeled "Other")
  const ctryOnly = rates.find(r => r.country === country && (!r.city || r.city === "Other" || r.city === ""));
  if (ctryOnly) return ctryOnly;
  return null;
}

function sameLoc(a?: { country: string; city: string }, b?: { country: string; city: string }) {
  if (!a || !b) return false;
  return (a.country || "") === (b.country || "") && (a.city || "") === (b.city || "");
}

function cityToSelectValue(city: string) { return city && city.trim() !== "" ? city : CITY_COUNTRY_ONLY_SENTINEL; }
function selectValueToCity(v: string) { return v === CITY_COUNTRY_ONLY_SENTINEL ? "" : v; }

// ——— Main Component ———
export default function PerDiemApp() {
  // Dataset (Rates)
  const [rates, setRates] = useState<typeof emptyRates>(emptyRates);
  const [ratesStatus, setRatesStatus] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const countryCityMap = useMemo(() => buildCountryCityMap(rates), [rates]);
  const allCountries = useMemo(() => Array.from(countryCityMap.keys()).sort(), [countryCityMap]);
  const cityList = (country: string) => Array.from(countryCityMap.get(country) || new Set<string>()).sort();

  // Employees
  const [employees, setEmployees] = useState(defaultEmployees);
  const [selectedEmpId, setSelectedEmpId] = useState(employees[0]?.id || "");
  const selectedEmp = employees.find(e => e.id === selectedEmpId) || null;

  const [empPanelOpen, setEmpPanelOpen] = useState(false);
  const [empForm, setEmpForm] = useState({ id: "", name: "", basePrimary: { country: "Germany", city: "Berlin" }, baseSecondary: { country: "", city: "" } });

  // Month selector
  const [month, setMonth] = useState(() => {
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${m}`; // yyyy-mm
  });

  // Trip legs
  type Leg = { id: string; startUtc: string; endUtc: string; from: { country: string; city: string }; to: { country: string; city: string }; breakfast?: boolean };

  // Factory to make a new leg using selected employee's primary base
  const makeDefaultLeg = (): Leg => {
    const id = (globalThis as any).crypto?.randomUUID ? (globalThis as any).crypto.randomUUID() : Math.random().toString(36).slice(2);
    const startUtc = new Date().toISOString().slice(0, 16);
    const endUtc = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16);
    const defCountry = selectedEmp?.basePrimary.country || "";
    const defCity = selectedEmp?.basePrimary.city || "";
    return { id, startUtc, endUtc, from: { country: defCountry, city: defCity }, to: { country: defCountry, city: defCity }, breakfast: false };
  };

  const [legs, setLegs] = useState<Leg[]>([makeDefaultLeg()]);

  // ——— Rates: upload, persist & auto-load ———
  function onUploadRatesFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || "");
        let parsed: typeof emptyRates = [];
        if (/^\s*\[/.test(text)) {
          // JSON array
          parsed = normalizeRates(JSON.parse(text));
        } else if (/^\s*\{/.test(text)) {
          // JSON object (e.g., { countries: [...] })
          parsed = normalizeRates(JSON.parse(text));
        } else {
          // CSV
          parsed = parseCSV(text);
        }
        const cleaned = parsed.filter(r => r.country);
        setRates(cleaned);
        try { localStorage.setItem(LS_RATES_KEY, JSON.stringify(cleaned)); } catch {}
      } catch (e) {
        alert("Failed to parse rates file. Supported: CSV with headers OR JSON (flat array or { countries:[{ country, entries:[...] }] }).");
      }
    };
    reader.readAsText(file);
  }

  useEffect(() => {
    let cancelled = false;
    async function hydrateRates() {
      // 1) localStorage
      try {
        const raw = localStorage.getItem(LS_RATES_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (!cancelled && Array.isArray(parsed) && parsed.length) { setRates(parsed); setRatesStatus("loaded"); return; }
        }
      } catch {}
      // 2) fetch default JSON from any candidate path
      setRatesStatus("loading");
      for (const url of DEFAULT_RATE_CANDIDATES) {
        try {
          const res = await fetch(url, { cache: "no-store" });
          if (!res.ok) continue;
          const json = await res.json();
          const cleaned = normalizeRates(json);
          if (!cancelled && cleaned.length) { setRates(cleaned); setRatesStatus("loaded"); try { localStorage.setItem(LS_RATES_KEY, JSON.stringify(cleaned)); } catch {} return; }
        } catch (e) { /* try next candidate */ }
      }
      if (!cancelled) setRatesStatus("error");
    }
    hydrateRates();
    return () => { cancelled = true; };
  }, []);

  // Ensure new legs created after employee change reflect the new base (existing legs remain untouched)
  useEffect(() => {
    // No-op here; the factory reads selectedEmp at creation time.
  }, [selectedEmpId]);

  // ——— Handlers ———
  function addOrUpdateEmployee() {
    const id = empForm.id.toUpperCase();
    if (!/^[A-Z]{3}$/.test(id)) { alert("Employee ID must be exactly 3 letters (A‑Z)."); return; }
    const exists = employees.some(e => e.id === id);
    const entry = { id, name: empForm.name.trim() || id, basePrimary: { ...empForm.basePrimary }, baseSecondary: { ...empForm.baseSecondary } };
    const next = exists ? employees.map(e => (e.id === id ? entry : e)) : [...employees, entry];
    setEmployees(next); setSelectedEmpId(id); setEmpPanelOpen(false);
  }

  function addLeg() { setLegs(l => [...l, makeDefaultLeg()]); }
  function removeLeg(id: string) { setLegs(l => l.filter(x => x.id !== id)); }

  function exportCSV() {
    const rows: string[][] = [];
    rows.push(["employee_id","employee_name","month","start_utc","end_utc","from_country","from_city","to_country","to_city","per_diem_eur"]);
    const calc = calculatePerDiems();
    for (const item of calc.items) rows.push([selectedEmp?.id || "", selectedEmp?.name || "", month, item.leg.startUtc, item.leg.endUtc, item.leg.from.country, item.leg.from.city, item.leg.to.country, item.leg.to.city, String(item.perDiemEUR.toFixed(2))]);
    const csv = toCSV(rows); const blob = new Blob([csv], { type: "text/csv;charset=utf-8" }); const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `per_diem_${selectedEmp?.id || "EMP"}_${month}.csv`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }
  function exportPDF() { alert("PDF export will be wired next (html2canvas + jsPDF). For now, use CSV."); }

  // ——— Per‑Diem Calculation (Scaffold + updated base rule) ———
  function calculatePerDiems() {
    const items: Array<{ leg: any; perDiemEUR: number; reason: string }> = [];
    for (const leg of legs) {
      const fromLoc = leg.from; const toLoc = leg.to;
      const hasSecondary = !!(selectedEmp?.baseSecondary && selectedEmp.baseSecondary.country && selectedEmp.baseSecondary.city);
      const secBase = hasSecondary ? selectedEmp!.baseSecondary : undefined;
      const isFromPrimary = sameLoc(fromLoc, selectedEmp?.basePrimary);
      const isToPrimary = sameLoc(toLoc, selectedEmp?.basePrimary);
      const isFromSecondary = hasSecondary && sameLoc(fromLoc, secBase as any);
      const isToSecondary = hasSecondary && sameLoc(toLoc, secBase as any);
      const legIsHomeOnly = (isFromPrimary && isToPrimary) || (isFromSecondary && isToSecondary);
      if (legIsHomeOnly) { items.push({ leg, perDiemEUR: 0, reason: "home‑base only leg" }); continue; }
      const start = new Date(leg.startUtc + ":00Z"); const end = new Date(leg.endUtc + ":00Z");
      const durMs = Math.max(0, end.getTime() - start.getTime()); const durHours = durMs / 3_600_000;
      const arrivesPrimary = isToPrimary; const arrivesSecondary = isToSecondary;
      const referenceForRates = (arrivesPrimary || arrivesSecondary) ? fromLoc : toLoc;
      const rate = guessRatesByLocation(rates, referenceForRates.country, referenceForRates.city);
      if (!rate) { items.push({ leg, perDiemEUR: 0, reason: "rate not found" }); continue; }
      let per = 0;
      if (durHours >= 24) per = rate.full_day_eur;
      else if (durHours >= 8) per = rate.eight_plus_eur;
      else per = 0;
      if ((leg as any).breakfast && per > 0) { per = Math.max(0, per - 0.2 * rate.full_day_eur); }
      items.push({ leg, perDiemEUR: per, reason: "scaffold thresholds (>=8h, >=24h)" });
    }
    return { items };
  }

  // ——— Hidden Dev Tests (console only) ———
  useEffect(() => {
    try {
      // A) flat array
      const tA = [ { country: "Germany", city: null, full_day_eur: 30, eight_plus_eur: 15 }, { country: "Germany", city: "Berlin", full_day_eur: 40, eight_plus_eur: 20 } ];
      const nA = normalizeRates(tA);
      console.assert(nA.length === 2 && nA[1].city === "Berlin", "Flat normalize failed");
      // B) nested object (like per_diem_2025.json)
      const tB = { countries: [ { country: "Poland", entries: [ { city: null, full_day_eur: 34, eight_plus_eur: 23 }, { city: "Warsaw", full_day_eur: 40, eight_plus_eur: 27 } ] } ] };
      const nB = normalizeRates(tB);
      console.assert(nB.length === 2 && nB[1].city === "Warsaw", "Nested normalize failed");
      // Exact vs fallback
      const tRates = [ { country: "Germany", city: null, full_day_eur: 30, eight_plus_eur: 15 }, { country: "Germany", city: "Berlin", full_day_eur: 40, eight_plus_eur: 20 } ];
      console.assert(guessRatesByLocation(tRates as any, "Germany", "Berlin")?.full_day_eur === 40, "Exact city rate failed");
      console.assert(guessRatesByLocation(tRates as any, "Germany", "Munich")?.full_day_eur === 30, "Country fallback failed");
      // Sentinel mapping
      console.assert(cityToSelectValue("") === CITY_COUNTRY_ONLY_SENTINEL && selectValueToCity(CITY_COUNTRY_ONLY_SENTINEL) === "", "Sentinel mapping failed");
      // Breakfast deduction per leg: 20% of full-day from reference location
      {
        const rate = { full_day_eur: 40, eight_plus_eur: 20 };
        let per = rate.eight_plus_eur; // 8h+
        per = Math.max(0, per - 0.2 * rate.full_day_eur);
        console.assert(per === 12, "Breakfast per-leg deduction failed (expected 12)");
      }
    } catch (e) { console.warn("Dev tests error:", e); }
  }, []);

  // ——— UI ———
  return (
    <div className="mx-auto max-w-6xl p-4 space-y-4">
      {/* Top line: Logo + Employee */}
      <div className="flex items-center gap-4">
        <img src="/logo.png" alt="Logo" className="h-10 w-auto" />
        <Card className="flex-1">
          <CardContent className="p-4">
            <div className="flex items-end gap-3 flex-wrap">
              <div className="min-w-[220px]">
                <label className="mb-1 block text-sm font-medium">Employee</label>
                <select className="w-[220px] rounded-xl border px-3 py-2 text-sm" value={selectedEmpId} onChange={(e) => setSelectedEmpId(e.target.value)}>
                  {employees.map(e => (<option key={e.id} value={e.id}>{e.id} — {e.name}</option>))}
                </select>
              </div>
              <Button type="button" variant="outline" className="gap-2" onClick={() => setEmpPanelOpen(v => !v)}>
                <IconEdit className="h-4 w-4" /> Add / Edit employee
              </Button>
            </div>
            {empPanelOpen && (
              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div><label className="mb-1 block text-sm font-medium">Employee ID (3 letters)</label><Input value={empForm.id} maxLength={3} onChange={e => setEmpForm({ ...empForm, id: e.target.value.toUpperCase() })} /></div>
                <div><label className="mb-1 block text-sm font-medium">Employee Name</label><Input value={empForm.name} onChange={e => setEmpForm({ ...empForm, name: e.target.value })} /></div>
                <div><label className="mb-1 block text-sm font-medium">Primary Base — Country</label><Input value={empForm.basePrimary.country} onChange={e => setEmpForm({ ...empForm, basePrimary: { ...empForm.basePrimary, country: e.target.value } })} /></div>
                <div><label className="mb-1 block text-sm font-medium">Primary Base — City</label><Input value={empForm.basePrimary.city} onChange={e => setEmpForm({ ...empForm, basePrimary: { ...empForm.basePrimary, city: e.target.value } })} /></div>
                <div>
                  <label className="mb-1 block text-sm font-medium">Secondary Base — Country</label>
                  <select className="w-full rounded-xl border px-3 py-2 text-sm" value={empForm.baseSecondary.country}
                          onChange={(e) => setEmpForm({ ...empForm, baseSecondary: { country: e.target.value, city: "" } })}>
                    <option value="">(none)</option>
                    {allCountries.map(c => (<option key={c} value={c}>{c}</option>))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">Secondary Base — City</label>
                  <select className="w-full rounded-xl border px-3 py-2 text-sm" disabled={!empForm.baseSecondary.country} value={cityToSelectValue(empForm.baseSecondary.city)}
                          onChange={(e) => setEmpForm({ ...empForm, baseSecondary: { ...empForm.baseSecondary, city: selectValueToCity(e.target.value) } })}>
                    {cityList(empForm.baseSecondary.country).map(ct => (<option key={ct} value={ct}>{ct}</option>))}
                    <option value={CITY_COUNTRY_ONLY_SENTINEL}>(country only)</option>
                  </select>
                </div>
                <div className="md:col-span-2"><Button type="button" onClick={addOrUpdateEmployee}><IconPlus className="h-4 w-4 mr-1" /> Save Employee</Button></div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Second row: Month + right‑side buttons */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <label className="mb-1 block text-sm font-medium">Month</label>
          <Input type="month" value={month} onChange={e => setMonth(e.target.value)} className="w-[200px]" />
        </div>
        <div className="flex items-center gap-3">
          <label className="inline-flex items-center gap-2">
            <input type="file" accept=".json,.csv" className="hidden" onChange={e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) onUploadRatesFile(f); (e.currentTarget as HTMLInputElement).value = ""; }} />
            <Button type="button" variant="secondary" className="gap-2" onClick={() => (document.querySelector<HTMLInputElement>('input[type=file]')?.click())}>
              <IconDatabase className="h-4 w-4" /> Data Base
            </Button>
          </label>
          <Badge className="text-xs">Rates: {rates.length} {ratesStatus === "loading" && "• loading..."} {ratesStatus === "error" && "• not found"}</Badge>
          <Button type="button" variant="outline" className="gap-2" onClick={exportCSV}><IconDownload className="h-4 w-4" /> Export CSV</Button>
          <Button type="button" className="gap-2" onClick={exportPDF}><IconDownload className="h-4 w-4" /> Export PDF</Button>
        </div>
      </div>

      {/* Trip Legs */}
      <Card>
        <CardHeader><CardTitle>Trip Legs</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-3">
            {legs.map((leg, idx) => (
              <div key={leg.id} className="grid grid-cols-12 gap-2 items-center">
                {/* Start / End (UTC) */}
                <div className="col-span-2 min-w-[180px]"><label className="sr-only">Start (UTC)</label><Input type="datetime-local" step={60} value={leg.startUtc} onChange={e => setLegs(prev => prev.map(l => l.id === leg.id ? { ...l, startUtc: e.target.value } : l))} /></div>
                <div className="col-span-2 min-w-[180px]"><label className="sr-only">End (UTC)</label><Input type="datetime-local" step={60} value={leg.endUtc} onChange={e => setLegs(prev => prev.map(l => l.id === leg.id ? { ...l, endUtc: e.target.value } : l))} /></div>

                {/* From country/city */}
                <div className="col-span-2 min-w-[160px]">
                  <label className="sr-only">From — Country</label>
                  <select className="w-full rounded-xl border px-3 py-2 text-sm" value={leg.from.country} onChange={(e) => setLegs(prev => prev.map(l => l.id === leg.id ? { ...l, from: { country: e.target.value, city: "" } } : l))}>
                    {allCountries.map(c => (<option key={c} value={c}>{c}</option>))}
                  </select>
                </div>
                <div className="col-span-1 min-w-[140px]">
                  <label className="sr-only">From — City</label>
                  <select className="w-full rounded-xl border px-3 py-2 text-sm" value={cityToSelectValue(leg.from.city)} onChange={(e) => setLegs(prev => prev.map(l => l.id === leg.id ? { ...l, from: { ...l.from, city: selectValueToCity(e.target.value) } } : l))}>
                    {[...(countryCityMap.get(leg.from.country) || new Set<string>())].sort().map(ct => (<option key={ct} value={ct}>{ct}</option>))}
                    <option value={CITY_COUNTRY_ONLY_SENTINEL}>(country only)</option>
                  </select>
                </div>

                {/* To country/city */}
                <div className="col-span-2 min-w-[160px]">
                  <label className="sr-only">To — Country</label>
                  <select className="w-full rounded-xl border px-3 py-2 text-sm" value={leg.to.country} onChange={(e) => setLegs(prev => prev.map(l => l.id === leg.id ? { ...l, to: { country: e.target.value, city: "" } } : l))}>
                    {allCountries.map(c => (<option key={c} value={c}>{c}</option>))}
                  </select>
                </div>
                <div className="col-span-1 min-w-[140px]">
                  <label className="sr-only">To — City</label>
                  <select className="w-full rounded-xl border px-3 py-2 text-sm" value={cityToSelectValue(leg.to.city)} onChange={(e) => setLegs(prev => prev.map(l => l.id === leg.id ? { ...l, to: { ...l.to, city: selectValueToCity(e.target.value) } } : l))}>
                    {[...(countryCityMap.get(leg.to.country) || new Set<string>())].sort().map(ct => (<option key={ct} value={ct}>{ct}</option>))}
                    <option value={CITY_COUNTRY_ONLY_SENTINEL}>(country only)</option>
                  </select>
                </div>

                {/* Row actions */}
                <div className="col-span-2 flex items-center gap-2 justify-end">
                  <Button type="button" variant="outline" onClick={() => removeLeg(leg.id)}>Remove</Button>
                  {idx === legs.length - 1 && (<Button type="button" onClick={addLeg}><span className="mr-1">+</span> Add</Button>)}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Simple live calc preview */}
      <Card>
        <CardHeader><CardTitle>Calculation Preview</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left border-b">
                <th className="py-2 pr-2">Start</th>
                <th className="py-2 pr-2">End</th>
                <th className="py-2 pr-2">From</th>
                <th className="py-2 pr-2">To</th>
                <th className="py-2 pr-2">Breakfast</th>
                <th className="py-2 pr-2">Per‑Diem (EUR)</th>
                <th className="py-2 pr-2">Reason</th>
              </tr></thead>
              <tbody>
                {calculatePerDiems().items.map((it, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-1 pr-2">{it.leg.startUtc}</td>
                    <td className="py-1 pr-2">{it.leg.endUtc}</td>
                    <td className="py-1 pr-2">{it.leg.from.country}{it.leg.from.city ? `, ${it.leg.from.city}` : ""}</td>
                    <td className="py-1 pr-2">{it.leg.to.country}{it.leg.to.city ? `, ${it.leg.to.city}` : ""}</td>
                    <td className="py-1 pr-2">
                      <label className="inline-flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={!!it.leg.breakfast}
                          onChange={e => setLegs(prev => prev.map(l => l.id === it.leg.id ? { ...l, breakfast: e.target.checked } : l))}
                        />
                        20%
                      </label>
                    </td>
                    <td className="py-1 pr-2">{it.perDiemEUR.toFixed(2)}</td>
                    <td className="py-1 pr-2 text-neutral-500">{it.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="text-xs text-neutral-500">v4.8 • fixed CardContent close • one‑line legs • auto-load nested JSON • DB-powered secondary base • per‑leg breakfast • 1‑min step • base rule updated</div>
    </div>
  );
}
