import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Per‑Diem Web App — App.tsx (rev8)
 * ---------------------------------------------------------------
 * Fix for build error: previous canvas only had a JSX fragment and referenced
 * `breakfastByDate` without defining it. This file restores a complete,
 * compilable React component and correctly initializes `breakfastByDate`.
 *
 * Highlights kept/added:
 * - Destination logic: for multi‑day legs use TO location rate; for single‑day
 *   return‑to‑base use FROM (Rule B). Breakfast once per date.
 * - Preview shows **From→To** for the first day of a multi‑day leg and
 *   **To→To** for subsequent days.
 * - Rates loader (JSON/CSV), Employees localStorage + Export/Import JSON,
 *   Trips localStorage, CSV+PDF export with header (logo, employee, month, total).
 */

// ——— Tiny UI wrappers (Tailwind-only) ———
function Card(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={"rounded-2xl border shadow-sm bg-white " + (props.className || "")} />;
}
function CardHeader(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={"px-4 pt-4 " + (props.className || "")} />;
}
function CardTitle(props: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 {...props} className={"text-lg font-semibold " + (props.className || "")} />;
}
const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function CardContent(props, ref) {
  return <div ref={ref} {...props} className={"p-4 " + (props.className || "")} />;
});
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
const Icon = (p:any)=> <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p} />;
function IconPlus(props:any){ return <Icon {...props}><path d="M12 5v14"/><path d="M5 12h14"/></Icon>; }
function IconTrash(props:any){ return <Icon {...props}><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></Icon>; }
function IconEdit(props:any){ return <Icon {...props}><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></Icon>; }
function IconUpload(props:any){ return <Icon {...props}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></Icon>; }

// ——— Types & constants ———
const emptyRates = [] as Array<{ country: string; city?: string | null; full_day_eur: number; eight_plus_eur: number; }>;

type Employee = { id: string; name: string; basePrimary: { country: string; city: string }; baseSecondary: { country: string; city: string } };
const defaultEmployees: Employee[] = [ { id: "BER", name: "Default Pilot", basePrimary: { country: "Germany", city: "Berlin" }, baseSecondary: { country: "", city: "" } } ];

const CITY_COUNTRY_ONLY_SENTINEL = "__country_only__";
const LS_RATES_KEY = "perdiem_rates_v1";
const LS_TRIPS_KEY = "perdiem_trips_v1";
const LS_EMPLOYEES_KEY = "perdiem_employees_v1";

const SAFE_BASE_URL: string = (() => { try { // @ts-ignore
  const b = (import.meta && (import.meta as any).env && (import.meta as any).env.BASE_URL) || "/"; return typeof b === "string" ? (b.endsWith("/") ? b : b + "/") : "/"; } catch { return "/"; }})();
const DEFAULT_LOGO_URL = SAFE_BASE_URL + "logo.png";
const DEFAULT_RATE_CANDIDATES = [ SAFE_BASE_URL + "per_diem_2025.json", "/per_diem_2025.json" ];

// ——— Helpers ———
function normalizeRates(jsonData: any): typeof emptyRates {
  if (Array.isArray(jsonData)) {
    return (jsonData as any[]).map(r => ({ country: String(r?.country||"").trim(), city: r?.city==null? null : String(r.city).trim(), full_day_eur: Number(r?.full_day_eur||0), eight_plus_eur: Number(r?.eight_plus_eur||0) })).filter(r=>r.country);
  }
  if (jsonData && Array.isArray(jsonData.countries)) {
    const out: typeof emptyRates = [];
    for (const c of jsonData.countries) {
      const country = String(c?.country||"").trim(); if(!country) continue;
      const entries = Array.isArray(c?.entries)? c.entries : [];
      for (const e of entries) out.push({ country, city: e?.city==null? null : String(e.city).trim(), full_day_eur: Number(e?.full_day_eur||0), eight_plus_eur: Number(e?.eight_plus_eur||0) });
    }
    return out.filter(r=>r.country);
  }
  return [] as typeof emptyRates;
}
function parseCSV(text: string) {
  const lines = text.split(/\r?\n/).filter(Boolean); if(!lines.length) return [] as typeof emptyRates;
  const header = lines[0].split(",").map(h=>h.trim().toLowerCase());
  const idx = { country: header.indexOf("country"), city: header.indexOf("city"), full: header.indexOf("full_day_eur"), eight: header.indexOf("eight_plus_eur") } as const;
  const out: typeof emptyRates = [];
  for (let i=1;i<lines.length;i++){
    const row = lines[i]; const cols:string[]=[]; let cur=""; let inQ=false;
    for (let j=0;j<row.length;j++){ const ch=row[j]; if(ch==='"'){ if(inQ && row[j+1]==='"'){cur+='"'; j++;} else inQ=!inQ; } else if(ch===',' && !inQ){ cols.push(cur); cur=""; } else cur+=ch; }
    cols.push(cur);
    const get=(k:number)=> (k>=0 && k<cols.length? cols[k].trim():"");
    const country=get(idx.country); if(!country) continue;
    out.push({ country, city: (get(idx.city)||null), full_day_eur: Number(get(idx.full)||0), eight_plus_eur: Number(get(idx.eight)||0) });
  }
  return out;
}
function buildCountryCityMap(rates: typeof emptyRates){ const m=new Map<string,Set<string>>(); for(const r of rates){ const c=r.country?.trim(); const t=(r.city??"").trim(); if(!c) continue; if(!m.has(c)) m.set(c,new Set()); if(t) m.get(c)!.add(t);} return m; }
const countryListFromMap = (m:Map<string,Set<string>>)=> Array.from(m.keys()).sort();
const citiesFor = (m:Map<string,Set<string>>, country:string)=> Array.from(m.get(country)||new Set<string>()).sort();
const cityToSelectValue = (city:string)=> city && city.trim()!=="" ? city : CITY_COUNTRY_ONLY_SENTINEL;
const selectValueToCity = (v:string)=> v===CITY_COUNTRY_ONLY_SENTINEL? "" : v;
const sameLoc = (a?:{country:string; city:string}, b?:{country:string; city:string}) => !!a && !!b && (a.country||"")===(b.country||"") && (a.city||"")===(b.city||"");
function guessRatesByLocation(rates: typeof emptyRates, country:string, city:string){
  const exact = rates.find(r=> r.country===country && (r.city||"")===(city||"")); if(exact) return exact;
  const fallback = rates.find(r=> r.country===country && (!r.city || r.city==="Other" || r.city==="")); return fallback||null;
}
function toCSV(rows: string[][]){ return rows.map(r=> r.map(c=>{ const s=String(c??""); return /[",\n]/.test(s)? '"'+s.replace(/"/g,'""')+'"' : s; }).join(",")).join("\n"); }

// ——— Component ———
export default function App(){
  // Rates
  const [rates, setRates] = useState<typeof emptyRates>(emptyRates);
  const [ratesStatus, setRatesStatus] = useState<"idle"|"loading"|"loaded"|"error">("idle");
  const ccMap = useMemo(()=>buildCountryCityMap(rates),[rates]);
  const allCountries = useMemo(()=>countryListFromMap(ccMap),[ccMap]);
  const cityList = (c:string)=> citiesFor(ccMap,c);

  // Employees
  const [employees, setEmployees] = useState<Employee[]>(defaultEmployees);
  const [selectedEmpId, setSelectedEmpId] = useState(employees[0]?.id || "");
  const selectedEmp = employees.find(e=>e.id===selectedEmpId) || null;
  const [empPanelOpen, setEmpPanelOpen] = useState(false);
  const [empForm, setEmpForm] = useState<Employee>({ id: "", name: "", basePrimary: { country: "Germany", city: "Berlin" }, baseSecondary: { country: "", city: "" } });

  // Month selector
  const [month, setMonth] = useState(()=>{ const d=new Date(); const y=d.getUTCFullYear(); const m=String(d.getUTCMonth()+1).padStart(2,"0"); return `${y}-${m}`; });

  // Legs
  type Leg = { id: string; startUtc: string; endUtc: string; from: { country: string; city: string }; to: { country: string; city: string } };
  const makeDefaultLeg = (): Leg => {
    const id = (globalThis as any).crypto?.randomUUID ? (globalThis as any).crypto.randomUUID() : Math.random().toString(36).slice(2);
    const today=new Date(); const y=today.getUTCFullYear(); const m=String(today.getUTCMonth()+1).padStart(2,"0"); const d=String(today.getUTCDate()).padStart(2,"0");
    const startUtc=`${y}-${m}-${d}T00:00`; const endUtc=`${y}-${m}-${d}T23:59`;
    const defC=selectedEmp?.basePrimary.country||""; const defT=selectedEmp?.basePrimary.city||"";
    return { id, startUtc, endUtc, from:{ country:defC, city:defT }, to:{ country:defC, city:defT } };
  };
  const [legs, setLegs] = useState<Leg[]>([makeDefaultLeg()]);

  // Breakfast per calendar date (initialized safely)
  const [breakfastByDate, setBreakfastByDate] = useState<Record<string, boolean>>({});

  // PDF ref
  const previewRef = useRef<HTMLDivElement>(null);

  // Load rates
  useEffect(()=>{ let cancelled=false; (async()=>{
    try{ const raw=localStorage.getItem(LS_RATES_KEY); if(raw){ const arr=JSON.parse(raw); if(Array.isArray(arr)&&arr.length){ setRates(arr); setRatesStatus("loaded"); return; } } }catch{}
    setRatesStatus("loading");
    for(const url of DEFAULT_RATE_CANDIDATES){ try{ const res=await fetch(url,{cache:"no-store"}); if(!res.ok) continue; const json=await res.json(); const cleaned=normalizeRates(json); if(cleaned.length){ if(!cancelled){ setRates(cleaned); setRatesStatus("loaded"); try{ localStorage.setItem(LS_RATES_KEY, JSON.stringify(cleaned)); }catch{} } return; } }catch{} }
    if(!cancelled) setRatesStatus("error");
  })(); return ()=>{cancelled=true}; },[]);

  function onUploadRatesFile(file: File){ const r=new FileReader(); r.onload=()=>{ try{ const text=String(r.result||""); let parsed:typeof emptyRates=[]; if(/^\s*\[/.test(text)) parsed=normalizeRates(JSON.parse(text)); else if(/^\s*\{/.test(text)) parsed=normalizeRates(JSON.parse(text)); else parsed=parseCSV(text); const cleaned=parsed.filter(x=>x.country); setRates(cleaned); try{localStorage.setItem(LS_RATES_KEY, JSON.stringify(cleaned));}catch{} }catch{ alert("Failed to parse rates JSON/CSV"); } }; r.readAsText(file); }

  // Employees persistence
  useEffect(()=>{ try{ const raw=localStorage.getItem(LS_EMPLOYEES_KEY); if(raw){ const arr=JSON.parse(raw); if(Array.isArray(arr)&&arr.length){ setEmployees(arr); if(!arr.some((e:Employee)=>e.id===selectedEmpId)) setSelectedEmpId(arr[0].id); } } }catch{} },[]);
  useEffect(()=>{ try{ localStorage.setItem(LS_EMPLOYEES_KEY, JSON.stringify(employees)); }catch{} }, [employees]);

  function addOrUpdateEmployee(){ const id=empForm.id.toUpperCase(); if(!/^[A-Z]{3}$/.test(id)){ alert("Employee ID must be exactly 3 letters"); return; } const entry:Employee={ id, name: empForm.name.trim()||id, basePrimary:{...empForm.basePrimary}, baseSecondary:{...empForm.baseSecondary} }; setEmployees(prev=>{ const exists=prev.some(e=>e.id===id); const next=exists? prev.map(e=>e.id===id? entry : e) : [...prev, entry]; return next.sort((a,b)=>a.id.localeCompare(b.id)); }); setSelectedEmpId(id); setEmpPanelOpen(false); }
  function exportEmployeesJSON(){ try{ const data=JSON.stringify(employees,null,2); const blob=new Blob([data],{type:'application/json;charset=utf-8'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='employees.json'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);}catch{ alert('Export failed'); } }
  function onImportEmployeesFile(file: File){ const r=new FileReader(); r.onload=()=>{ try{ const arr=JSON.parse(String(r.result||'')); if(!Array.isArray(arr)) throw new Error('invalid'); const cleaned:Employee[]=arr.map((e:any)=>({ id:String(e?.id||'').toUpperCase(), name:String(e?.name||'').trim()||String(e?.id||'').toUpperCase(), basePrimary:{ country:String(e?.basePrimary?.country||''), city:String(e?.basePrimary?.city||'') }, baseSecondary:{ country:String(e?.baseSecondary?.country||''), city:String(e?.baseSecondary?.city||'') } })).filter(e=>/^[A-Z]{3}$/.test(e.id)); if(!cleaned.length) throw new Error('empty'); const byId=new Map<string,Employee>(); cleaned.forEach(e=>byId.set(e.id,e)); const finalArr=Array.from(byId.values()).sort((a,b)=>a.id.localeCompare(b.id)); setEmployees(finalArr); setSelectedEmpId(finalArr[0].id); try{ localStorage.setItem(LS_EMPLOYEES_KEY, JSON.stringify(finalArr)); }catch{} }catch{ alert('Import failed: JSON array of employees expected'); } }; r.readAsText(file); }

  // Trip helpers
  function addLeg(){ setLegs(l=>[...l, makeDefaultLeg()]); }
  function addNextLeg(){ setLegs(l=>{ const last=l[l.length-1]; const id=(globalThis as any).crypto?.randomUUID? (globalThis as any).crypto.randomUUID() : Math.random().toString(36).slice(2); if(!last) return [...l, makeDefaultLeg()]; const start=last.endUtc; const d=new Date(start+":00Z"); const endDay=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),23,59)); const endUtc=endDay.toISOString().slice(0,16); const from={...last.to}; const to={...last.from}; return [...l, { id, startUtc:start, endUtc, from, to }]; }); }
  function removeLeg(id:string){ setLegs(l=>l.filter(x=>x.id!==id)); }

  // Persist trips
  useEffect(()=>{ try{ localStorage.setItem(LS_TRIPS_KEY, JSON.stringify({ legs, breakfastByDate })); }catch{} }, [legs, breakfastByDate]);
  useEffect(()=>{ try{ const raw=localStorage.getItem(LS_TRIPS_KEY); if(raw){ const p=JSON.parse(raw); if(Array.isArray(p.legs)) setLegs(p.legs); if(p.breakfastByDate && typeof p.breakfastByDate==='object') setBreakfastByDate(p.breakfastByDate); } }catch{} }, []);

  // Calculation
  function calculatePerDiems(){
    function splitByUtcDay(startISO:string,endISO:string){ const out:Array<{start:Date; end:Date; dateKey:string; hours:number}>=[]; const s=new Date(startISO+":00Z"); const e=new Date(endISO+":00Z"); if(isNaN(s.getTime())||isNaN(e.getTime())||e<=s) return out; let cur=new Date(s); while(cur<e){ const dayEnd=new Date(Date.UTC(cur.getUTCFullYear(),cur.getUTCMonth(),cur.getUTCDate()+1,0,0,0)); const ce=new Date(Math.min(+dayEnd,+e)); const hours=(+ce-+cur)/3_600_000; const dk=`${cur.getUTCFullYear()}-${String(cur.getUTCMonth()+1).padStart(2,'0')}-${String(cur.getUTCDate()).padStart(2,'0')}`; out.push({start:new Date(cur), end:ce, dateKey:dk, hours}); cur=ce;} return out; }
    type Item = { leg:any; perDiemEUR:number; reason:string; segStart:string; segEnd:string; segDate:string; isFirst:boolean; key:string; breakfastApplied:boolean };
    const items: Item[] = []; const breakfastUsed=new Set<string>();
    for(const leg of legs){
      const fromLoc=leg.from, toLoc=leg.to; const hasSec=!!(selectedEmp?.baseSecondary && selectedEmp.baseSecondary.country && selectedEmp.baseSecondary.city); const secBase=hasSec? selectedEmp!.baseSecondary: undefined; const isFromPrim=sameLoc(fromLoc, selectedEmp?.basePrimary); const isToPrim=sameLoc(toLoc, selectedEmp?.basePrimary); const isFromSec=hasSec && sameLoc(fromLoc, secBase as any); const isToSec=hasSec && sameLoc(toLoc, secBase as any);
      const segments=splitByUtcDay(leg.startUtc, leg.endUtc);
      const legIsHomeOnly = (isFromPrim && isToPrim) || (isFromSec && isToSec);
      if(legIsHomeOnly){ for(let i=0;i<segments.length;i++){ const seg=segments[i]; const key=`${seg.dateKey}`; items.push({ leg, perDiemEUR:0, reason:"home‑base only", segStart:seg.start.toISOString().slice(0,16), segEnd:seg.end.toISOString().slice(0,16), segDate:seg.dateKey, isFirst:i===0, key, breakfastApplied:false }); } continue; }
      const arrivesBase = isToPrim || isToSec; const isMulti = segments.length>1; const rateLoc = isMulti ? toLoc : (arrivesBase ? fromLoc : toLoc); const rate = guessRatesByLocation(rates, rateLoc.country, rateLoc.city);
      if(!rate){ for(let i=0;i<segments.length;i++){ const seg=segments[i]; const key=`${seg.dateKey}`; items.push({ leg, perDiemEUR:0, reason:"rate not found", segStart:seg.start.toISOString().slice(0,16), segEnd:seg.end.toISOString().slice(0,16), segDate:seg.dateKey, isFirst:i===0, key, breakfastApplied:false }); } continue; }
      for(let i=0;i<segments.length;i++){ const seg=segments[i]; let per=0; let reason=""; if(seg.hours>=24-1e-6){ per=rate.full_day_eur; reason="full day (≥24h)"; } else if(seg.hours>8){ per=rate.eight_plus_eur; reason=">8h"; } else { per=0; reason="≤8h"; }
        const key=`${seg.dateKey}`; const wants=!!breakfastByDate[key]; const apply=wants && !breakfastUsed.has(key) && per>0; if(apply){ per=Math.max(0, per - 0.2*rate.full_day_eur); reason += " + breakfast −20%"; breakfastUsed.add(key);} items.push({ leg, perDiemEUR:per, reason, segStart:seg.start.toISOString().slice(0,16), segEnd:seg.end.toISOString().slice(0,16), segDate:seg.dateKey, isFirst:i===0, key, breakfastApplied:apply }); }
    }
    return { items };
  }

  function exportCSV(){ const rows:string[][]=[]; rows.push(["employee_id","employee_name","month","start_utc","end_utc","from_country","from_city","to_country","to_city","per_diem_eur","breakfast"]); const calc=calculatePerDiems(); for(const it of calc.items){ rows.push([selectedEmp?.id||"", selectedEmp?.name||"", month, it.segStart, it.segEnd, it.leg.from.country, it.leg.from.city, it.leg.to.country, it.leg.to.city, String(it.perDiemEUR.toFixed(2)), it.breakfastApplied?"yes":"no"]); } const csv=toCSV(rows); const blob=new Blob([csv],{type:"text/csv;charset=utf-8"}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=`per_diem_${selectedEmp?.id||'EMP'}_${month}.csv`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); }

  async function exportPDF(){ try{ const node=previewRef.current; if(!node){ alert("Preview not ready"); return; } const [html2canvasMod, jsPDFMod] = await Promise.all([ import(/* @vite-ignore */ 'html2canvas'), import(/* @vite-ignore */ 'jspdf') ]); const html2canvas=(html2canvasMod as any).default||(html2canvasMod as any); const { jsPDF } = jsPDFMod as any; const pdf=new jsPDF({orientation:'p', unit:'pt', format:'a4'}); const pw=pdf.internal.pageSize.getWidth(); const ph=pdf.internal.pageSize.getHeight(); const m=28; let y=m; let logoDataUrl:string|null=null; try{ const res=await fetch(DEFAULT_LOGO_URL,{cache:'no-store'}); if(res.ok){ const blob=await res.blob(); logoDataUrl=await new Promise<string>(resv=>{ const fr=new FileReader(); fr.onload=()=>resv(String(fr.result)); fr.readAsDataURL(blob); }); } }catch{} const total = calculatePerDiems().items.reduce((s,it)=>s+it.perDiemEUR,0); const empLine=`Employee: ${(selectedEmp?.id||'')}${selectedEmp?.name?` — ${selectedEmp.name}`:''}`; const monthLine=`Month: ${month}`; const totalLine=`Total per‑diem: € ${total.toFixed(2)}`; if(logoDataUrl){ const h=36, w=h*3; pdf.addImage(logoDataUrl,'PNG',m,y,w,h);} pdf.setFontSize(12); pdf.text(empLine, pw-m, y+14, {align:'right'}); pdf.text(monthLine, pw-m, y+30, {align:'right'}); pdf.text(totalLine, pw-m, y+46, {align:'right'}); y+=58; pdf.setDrawColor(200); pdf.line(m,y,pw-m,y); y+=10; const canvas = await html2canvas(node,{scale:2,useCORS:true,backgroundColor:'#fff'}); const imgData=canvas.toDataURL('image/png'); const imgW=pw-m*2; const imgH=canvas.height*(imgW/canvas.width); const space=ph-y-m; if(imgH<=space){ pdf.addImage(imgData,'PNG',m,y,imgW,imgH); } else { let pos=0; const sliceH=Math.floor(canvas.width*(space/imgW)); while(pos<canvas.height){ const slice=document.createElement('canvas'); slice.width=canvas.width; slice.height=Math.min(sliceH, canvas.height-pos); const ctx=slice.getContext('2d')!; ctx.drawImage(canvas,0,pos,canvas.width,slice.height,0,0,canvas.width,slice.height); const part=slice.toDataURL('image/png'); if(pos>0){ pdf.addPage(); y=m; } pdf.addImage(part,'PNG',m,y,imgW, slice.height*(imgW/canvas.width)); pos+=sliceH; } } pdf.save(`per_diem_${selectedEmp?.id||'EMP'}_${month}.pdf`); }catch(err){ console.error(err); alert('PDF export failed'); } }

  // ——— UI ———
  const calc = calculatePerDiems();
  const totalEUR = calc.items.reduce((s,it)=>s+it.perDiemEUR,0);

  return (
    <div className="mx-auto max-w-6xl p-4 space-y-4">
      {/* Top bar: Logo + Employee */}
      <div className="flex items-center gap-4">
        <img src={DEFAULT_LOGO_URL} alt="Logo" className="h-10 w-auto" />
        <Card className="flex-1">
          <CardContent>
            <div className="flex items-end gap-3 flex-wrap">
              <div className="min-w-[220px]">
                <label className="mb-1 block text-sm font-medium">Employee</label>
                <select className="w-[220px] rounded-xl border px-3 py-2 text-sm" value={selectedEmpId} onChange={(e)=>setSelectedEmpId(e.target.value)}>
                  {employees.map(e => (<option key={e.id} value={e.id}>{e.id} — {e.name}</option>))}
                </select>
              </div>
              <Button type="button" variant="outline" className="gap-2" onClick={()=>setEmpPanelOpen(v=>!v)}>
                <IconEdit className="h-4 w-4"/> Add / Edit employee
              </Button>
              <Button type="button" variant="outline" className="gap-2" onClick={exportEmployeesJSON}>Export employees</Button>
              <label className="text-sm inline-flex items-center gap-2 cursor-pointer">
                <input type="file" accept="application/json" className="hidden" id="empsFile" onChange={(e)=>{ const f=e.target.files?.[0]; if(f) onImportEmployeesFile(f); }} />
                <span onClick={()=>document.getElementById('empsFile')?.click()}>Import employees</span>
              </label>
              <div className="grow"/>
              <label className="mb-1 block text-sm font-medium">Month</label>
              <input type="month" className="rounded-xl border px-3 py-2 text-sm" value={month} onChange={(e)=>setMonth(e.target.value)} />
            </div>

            {empPanelOpen && (
              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-sm font-medium">Employee ID (3 letters)</label>
                  <Input value={empForm.id} maxLength={3} onChange={e=>setEmpForm({ ...empForm, id: e.target.value.toUpperCase() })} />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">Employee Name</label>
                  <Input value={empForm.name} onChange={e=>setEmpForm({ ...empForm, name: e.target.value })} />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">Primary Base — Country</label>
                  <Input value={empForm.basePrimary.country} onChange={e=>setEmpForm({ ...empForm, basePrimary: { ...empForm.basePrimary, country: e.target.value } })} />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">Primary Base — City</label>
                  <Input value={empForm.basePrimary.city} onChange={e=>setEmpForm({ ...empForm, basePrimary: { ...empForm.basePrimary, city: e.target.value } })} />
                </div>
                <div className="md:col-span-2 border-t pt-3">
                  <details>
                    <summary className="cursor-pointer text-sm font-medium">Secondary Home Base (optional)</summary>
                    <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
                      <div>
                        <label className="mb-1 block text-sm">Country</label>
                        <select className="w-full rounded-xl border px-3 py-2 text-sm" value={empForm.baseSecondary.country} onChange={(e)=>{ const c=e.target.value; const cities=cityList(c); setEmpForm({ ...empForm, baseSecondary: { country: c, city: cities[0]||"" } }); }}>
                          <option value="">— None —</option>
                          {allCountries.map(c => (<option key={c} value={c}>{c}</option>))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-sm">City</label>
                        <select className="w-full rounded-xl border px-3 py-2 text-sm" value={empForm.baseSecondary.city} onChange={(e)=>setEmpForm({ ...empForm, baseSecondary: { ...empForm.baseSecondary, city: selectValueToCity(e.target.value) } })}>
                          <option value="">— None —</option>
                          {empForm.baseSecondary.country && ["", ...cityList(empForm.baseSecondary.country)].map(cty => (
                            <option key={cty || CITY_COUNTRY_ONLY_SENTINEL} value={cityToSelectValue(cty)}>{cty || "(Country rate)"}</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-end"><Button variant="secondary" onClick={()=>setEmpForm({ ...empForm, baseSecondary: { country: "", city: "" } })}>Clear</Button></div>
                    </div>
                  </details>
                </div>
                <div className="md:col-span-2"><Button onClick={addOrUpdateEmployee}>Save Employee</Button></div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Rates + Export row */}
      <div className="flex items-center gap-3 flex-wrap">
        <Card className="p-3 flex items-center gap-3">
          <Badge>rates: {ratesStatus === 'loaded' ? 'default' : ratesStatus}</Badge>
          <label className="text-sm">
            <input type="file" accept=".json,.csv" className="hidden" id="ratesFile" onChange={(e)=>{ const f=e.target.files?.[0]; if(f) onUploadRatesFile(f); }} />
            <span className="inline-flex items-center gap-2 cursor-pointer" onClick={()=>document.getElementById('ratesFile')?.click()}>
              <IconUpload className="h-4 w-4"/> Load rates
            </span>
          </label>
        </Card>
        <div className="grow"/>
        <Button variant="outline" onClick={exportCSV}>Export CSV</Button>
        <Button variant="outline" onClick={exportPDF}>Export PDF</Button>
      </div>

      {/* Trip Legs */}
      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Trip Legs (UTC)</CardTitle>
          <div className="flex gap-2">
            <Button variant="secondary" className="gap-2" onClick={addLeg}><IconPlus className="h-4 w-4"/> Add new leg</Button>
            <Button variant="secondary" className="gap-2" onClick={addNextLeg}><IconPlus className="h-4 w-4"/> Next leg</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {legs.map((leg) => (
            <div key={leg.id} className="grid grid-cols-1 lg:grid-cols-12 gap-2 items-end">
              <div className="lg:col-span-2">
                <label className="text-xs block">Start UTC</label>
                <input type="datetime-local" step={300} className="w-full rounded-xl border px-3 py-2 text-sm" value={leg.startUtc} onChange={(e)=>setLegs(ls=>ls.map(x=>x.id===leg.id?{...x,startUtc:e.target.value}:x))} />
              </div>
              <div className="lg:col-span-2">
                <label className="text-xs block">End UTC</label>
                <input type="datetime-local" step={300} className="w-full rounded-xl border px-3 py-2 text-sm" value={leg.endUtc} onChange={(e)=>setLegs(ls=>ls.map(x=>x.id===leg.id?{...x,endUtc:e.target.value}:x))} />
              </div>
              <div className="lg:col-span-2">
                <label className="text-xs block">From — Country</label>
                <select className="w-full rounded-xl border px-3 py-2 text-sm" value={leg.from.country} onChange={(e)=>{ const c=e.target.value; const first=cityList(c)[0]||""; setLegs(ls=>ls.map(x=>x.id===leg.id?{...x, from:{country:c, city:first}}:x)); }}>
                  {allCountries.map(c => (<option key={c} value={c}>{c}</option>))}
                </select>
              </div>
              <div className="lg:col-span-1">
                <label className="text-xs block">From — City</label>
                <select className="w-full rounded-xl border px-3 py-2 text-sm" value={cityToSelectValue(leg.from.city)} onChange={(e)=>setLegs(ls=>ls.map(x=>x.id===leg.id?{...x, from:{...x.from, city: selectValueToCity(e.target.value)}}:x))}>
                  {["", ...cityList(leg.from.country)].map(cty => (<option key={cty || CITY_COUNTRY_ONLY_SENTINEL} value={cityToSelectValue(cty)}>{cty || "(Country rate)"}</option>))}
                </select>
              </div>
              <div className="lg:col-span-2">
                <label className="text-xs block">To — Country</label>
                <select className="w-full rounded-xl border px-3 py-2 text-sm" value={leg.to.country} onChange={(e)=>{ const c=e.target.value; const first=cityList(c)[0]||""; setLegs(ls=>ls.map(x=>x.id===leg.id?{...x, to:{country:c, city:first}}:x)); }}>
                  {allCountries.map(c => (<option key={c} value={c}>{c}</option>))}
                </select>
              </div>
              <div className="lg:col-span-1">
                <label className="text-xs block">To — City</label>
                <select className="w-full rounded-xl border px-3 py-2 text-sm" value={cityToSelectValue(leg.to.city)} onChange={(e)=>setLegs(ls=>ls.map(x=>x.id===leg.id?{...x, to:{...x.to, city: selectValueToCity(e.target.value)}}:x))}>
                  {["", ...cityList(leg.to.country)].map(cty => (<option key={cty || CITY_COUNTRY_ONLY_SENTINEL} value={cityToSelectValue(cty)}>{cty || "(Country rate)"}</option>))}
                </select>
              </div>
              <div className="lg:col-span-2 flex justify-end">
                <Button variant="outline" className="gap-2" onClick={()=>removeLeg(leg.id)}><IconTrash className="h-4 w-4"/> Remove</Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Calculation Preview */}
      <Card>
        <CardHeader><CardTitle>Calculation Preview</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto" ref={previewRef}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b">
                <th className="py-2">Day (UTC)</th>
                <th>Segment Start</th>
                <th>Segment End</th>
                <th>From</th>
                <th>To</th>
                <th>Breakfast</th>
                <th>Per‑Diem (€)</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {calc.items.map((it, i)=> {
                // Multi-day display: first day shows From→To, later days To→To
                const fromDisplay = it.isFirst ? `${it.leg.from.country}${it.leg.from.city ? ", "+it.leg.from.city : ""}` : `${it.leg.to.country}${it.leg.to.city ? ", "+it.leg.to.city : ""}`;
                const toDisplay = `${it.leg.to.country}${it.leg.to.city ? ", "+it.leg.to.city : ""}`;
                // Preview requirement: show only time (HH:MM). If full day, show "full day".
                const isFull = /full day/i.test(it.reason);
                const hhmm = (iso:string)=> iso.slice(11,16);
                const startCell = isFull ? "full day" : hhmm(it.segStart);
                const endCell = isFull ? "full day" : hhmm(it.segEnd);
                return (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-2">{it.segDate}</td>
                    <td>{startCell}</td>
                    <td>{endCell}</td>
                    <td>{fromDisplay}</td>
                    <td>{toDisplay}</td>
                    <td>
                      <input type="checkbox" checked={!!breakfastByDate[it.key]} onChange={(e)=> setBreakfastByDate(prev => ({ ...prev, [it.key]: e.target.checked }))} />
                    </td>
                    <td className="font-medium">{it.perDiemEUR.toFixed(2)}</td>
                    <td className="text-neutral-500">{it.reason}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-3 flex justify-end text-sm">
            <div className="rounded-xl border px-3 py-2 bg-neutral-50">
              <span className="mr-2 font-medium">Total per‑diem:</span>
              <span className="font-semibold">€ {totalEUR.toFixed(2)}</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
