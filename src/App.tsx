import React, { useEffect, useMemo, useRef, useState } from "react";

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
  const base = "inline-flex items-center justify-center rounded-xl px-3 py-2 text-sm font-medium shadow-sm transition disabled:opacity-50";
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

type Location = { country: string; city: string };
type Rate = { country: string; city?: string | null; full_day_eur: number; eight_plus_eur: number };
type Employee = { id: string; name: string; basePrimary: Location; baseSecondary: Location };
type Leg = { id: string; startUtc: string; endUtc: string; from: Location; to: Location };
type DailyPerDiem = {
  date: string;
  startUtc: string;
  endUtc: string;
  awayHours: number;
  from: Location;
  to: Location;
  rateLocation: Location;
  dayType: "FULL" | "HALF" | "NONE";
  perDiemEUR: number;
  breakfastApplied: boolean;
  reason: string;
};

const emptyRates = [] as Rate[];
const defaultEmployees: Employee[] = [
  {
    id: "BER",
    name: "Default Pilot",
    basePrimary: { country: "Germany", city: "Berlin" },
    baseSecondary: { country: "Poland", city: "Warsaw" },
  },
];

const CITY_COUNTRY_ONLY_SENTINEL = "__country_only__";
const LS_RATES_KEY = "perdiem_rates_v1";
const LS_TRIPS_KEY = "perdiem_trips_v2";
const LS_EMPLOYEES_KEY = "perdiem_employees_v1";

const SAFE_BASE_URL: string = (() => {
  try {
    // @ts-ignore
    const b = (import.meta && (import.meta as any).env && (import.meta as any).env.BASE_URL) || "/";
    return typeof b === "string" ? (b.endsWith("/") ? b : b + "/") : "/";
  } catch { return "/"; }
})();
const DEFAULT_LOGO_URL = SAFE_BASE_URL + "logo.png";
const DEFAULT_RATE_CANDIDATES = [SAFE_BASE_URL + "per_diem_2025.json", "/per_diem_2025.json"];

function normalizeRates(jsonData: any): Rate[] {
  if (Array.isArray(jsonData)) {
    return jsonData.map((r:any) => ({
      country: String(r?.country || "").trim(),
      city: r?.city == null ? null : String(r.city).trim(),
      full_day_eur: Number(r?.full_day_eur || 0),
      eight_plus_eur: Number(r?.eight_plus_eur || 0),
    })).filter((r:Rate) => r.country);
  }
  if (jsonData && Array.isArray(jsonData.countries)) {
    const out: Rate[] = [];
    for (const c of jsonData.countries) {
      const country = String(c?.country || "").trim();
      if (!country) continue;
      for (const e of (Array.isArray(c?.entries) ? c.entries : [])) {
        out.push({
          country,
          city: e?.city == null ? null : String(e.city).trim(),
          full_day_eur: Number(e?.full_day_eur || 0),
          eight_plus_eur: Number(e?.eight_plus_eur || 0),
        });
      }
    }
    return out;
  }
  return [];
}

function parseCSV(text: string): Rate[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split(",").map(h => h.trim().toLowerCase());
  const idx = {
    country: header.indexOf("country"), city: header.indexOf("city"),
    full: header.indexOf("full_day_eur"), eight: header.indexOf("eight_plus_eur"),
  };
  const out: Rate[] = [];
  for (let i=1;i<lines.length;i++) {
    const row = lines[i]; const cols:string[]=[]; let cur=""; let inQ=false;
    for (let j=0;j<row.length;j++) {
      const ch=row[j];
      if (ch==='"') { if (inQ && row[j+1]==='"') { cur+='"'; j++; } else inQ=!inQ; }
      else if (ch===',' && !inQ) { cols.push(cur); cur=""; }
      else cur+=ch;
    }
    cols.push(cur);
    const get=(k:number)=> (k>=0 && k<cols.length ? cols[k].trim() : "");
    const country=get(idx.country); if(!country) continue;
    out.push({ country, city:get(idx.city)||null, full_day_eur:Number(get(idx.full)||0), eight_plus_eur:Number(get(idx.eight)||0) });
  }
  return out;
}

function buildCountryCityMap(rates: Rate[]) {
  const map = new Map<string, Set<string>>();
  for (const r of rates) {
    const c = (r.country||"").trim(); const city=(r.city??"").trim();
    if (!c) continue;
    if (!map.has(c)) map.set(c, new Set());
    if (city) map.get(c)!.add(city);
  }
  return map;
}
const countryListFromMap=(m:Map<string,Set<string>>)=>Array.from(m.keys()).sort();
const citiesFor=(m:Map<string,Set<string>>,c:string)=>Array.from(m.get(c)||new Set<string>()).sort();
const cityToSelectValue=(city:string)=>city && city.trim()!=="" ? city : CITY_COUNTRY_ONLY_SENTINEL;
const selectValueToCity=(v:string)=>v===CITY_COUNTRY_ONLY_SENTINEL?"":v;
const sameLoc=(a?:Location,b?:Location)=>!!a&&!!b&&(a.country||"")===(b.country||"")&&(a.city||"")===(b.city||"");
const locLabel=(l:Location)=>`${l.country}${l.city ? ", "+l.city : ""}`;
const isoDate=(d:Date)=>`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
const isoMinute=(d:Date)=>d.toISOString().slice(0,16);
const hhmm=(iso:string)=>iso.slice(11,16);

function guessRatesByLocation(rates: Rate[], country:string, city:string) {
  const exact = rates.find(r=>r.country===country && (r.city||"")===(city||""));
  if (exact) return exact;
  return rates.find(r=>r.country===country && (!r.city || r.city==="Other" || r.city==="")) || null;
}
function toCSV(rows:string[][]){
  return rows.map(r=>r.map(c=>{const s=String(c??""); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}).join(",")).join("\n");
}

function homeBasesFor(emp: Employee | null): Location[] {
  if (!emp) return [];
  const bases=[emp.basePrimary];
  if (emp.baseSecondary.country && emp.baseSecondary.city) bases.push(emp.baseSecondary);
  return bases;
}
function isHome(loc:Location, homes:Location[]) { return homes.some(h=>sameLoc(loc,h)); }

function buildDailyPerDiems(legs:Leg[], rates:Rate[], homes:Location[], breakfastByDate:Record<string,boolean>): {items:DailyPerDiem[]; warnings:string[]} {
  const sorted=[...legs]
    .filter(l=>l.startUtc && l.endUtc)
    .sort((a,b)=>new Date(a.startUtc+":00Z").getTime()-new Date(b.startUtc+":00Z").getTime());
  const warnings:string[]=[];
  const trips:Array<{start:Date; end:Date; closed:boolean; legs:Leg[]; startLoc:Location; endLoc:Location}> = [];

  let active:null|{start:Date; legs:Leg[]; startLoc:Location}=null;
  for (const leg of sorted) {
    const s=new Date(leg.startUtc+":00Z"), e=new Date(leg.endUtc+":00Z");
    if (!(e>s)) { warnings.push(`Invalid leg: ${leg.startUtc} → ${leg.endUtc}`); continue; }
    const fromHome=isHome(leg.from,homes), toHome=isHome(leg.to,homes);
    if (!active) {
      if (fromHome && !toHome) active={start:s,legs:[leg],startLoc:leg.from};
      else if (!fromHome) active={start:s,legs:[leg],startLoc:leg.from};
      else continue; // home→home movement: no per diem trip
    } else {
      active.legs.push(leg);
    }
    if (active && toHome) {
      trips.push({start:active.start,end:e,closed:true,legs:active.legs,startLoc:active.startLoc,endLoc:leg.to});
      active=null;
    }
  }
  if (active && active.legs.length) {
    const last=active.legs[active.legs.length-1];
    const e=new Date(last.endUtc+":00Z");
    trips.push({start:active.start,end:e,closed:false,legs:active.legs,startLoc:active.startLoc,endLoc:last.to});
    warnings.push("Open trip: no return to a home base has been entered yet.");
  }

  type Candidate = {
    date:string; start:Date; end:Date; awayHours:number; from:Location; to:Location; rateLocation:Location; order:number;
  };
  const candidates:Candidate[]=[];
  let order=0;

  for (const trip of trips) {
    const tripLegs=[...trip.legs].sort((a,b)=>new Date(a.endUtc+":00Z").getTime()-new Date(b.endUtc+":00Z").getTime());
    let day = new Date(Date.UTC(trip.start.getUTCFullYear(),trip.start.getUTCMonth(),trip.start.getUTCDate(),0,0,0));
    const lastDay = new Date(Date.UTC(trip.end.getUTCFullYear(),trip.end.getUTCMonth(),trip.end.getUTCDate(),0,0,0));
    while (day<=lastDay) {
      const dayEnd=new Date(day.getTime()+86_400_000);
      const segStart=new Date(Math.max(day.getTime(),trip.start.getTime()));
      const segEnd=new Date(Math.min(dayEnd.getTime(),trip.end.getTime()));
      if (segEnd>segStart) {
        const arrivals=tripLegs.filter(l=>{const t=new Date(l.endUtc+":00Z").getTime(); return t>=day.getTime() && t<dayEnd.getTime();});
        const starts=tripLegs.filter(l=>{const t=new Date(l.startUtc+":00Z").getTime(); return t>=day.getTime() && t<dayEnd.getTime();});

        // Location at start of this calendar day.
        let startLoc:Location = trip.startLoc;
        const earlierArrivals=tripLegs.filter(l=>new Date(l.endUtc+":00Z").getTime()<day.getTime());
        if (earlierArrivals.length) startLoc=earlierArrivals[earlierArrivals.length-1].to;
        else if (day.getTime()===Date.UTC(trip.start.getUTCFullYear(),trip.start.getUTCMonth(),trip.start.getUTCDate())) startLoc=trip.startLoc;

        // Last place actually reached before midnight; if returning home, rate uses last non-home location.
        let endLoc:Location=startLoc;
        let rateLoc:Location=startLoc;
        for (const l of arrivals) {
          endLoc=l.to;
          if (isHome(l.to,homes)) rateLoc=l.from;
          else rateLoc=l.to;
        }
        if (!arrivals.length) {
          endLoc=startLoc;
          rateLoc=startLoc;
        }

        // On departure day, display the first actual FROM. On subsequent days, show carry-over location.
        if (starts.length && day.getTime()===Date.UTC(trip.start.getUTCFullYear(),trip.start.getUTCMonth(),trip.start.getUTCDate())) {
          startLoc=starts[0].from;
        }

        candidates.push({
          date:isoDate(day), start:segStart, end:segEnd,
          awayHours:(segEnd.getTime()-segStart.getTime())/3_600_000,
          from:startLoc, to:endLoc, rateLocation:rateLoc, order:order++,
        });
      }
      day=dayEnd;
    }
  }

  // One per-diem result per calendar date, even if there were several separate legs/trips that day.
  const grouped=new Map<string,Candidate[]>();
  for (const c of candidates) { if(!grouped.has(c.date)) grouped.set(c.date,[]); grouped.get(c.date)!.push(c); }
  const items:DailyPerDiem[]=[];
  for (const date of Array.from(grouped.keys()).sort()) {
    const list=grouped.get(date)!.sort((a,b)=>a.start.getTime()-b.start.getTime());
    const first=list[0], last=list[list.length-1];
    const awayHours=list.reduce((s,c)=>s+c.awayHours,0);
    const rateLoc=last.rateLocation;
    const rate=guessRatesByLocation(rates,rateLoc.country,rateLoc.city);
    let dayType:DailyPerDiem["dayType"]="NONE";
    let amount=0;
    let reason="≤8h away from home base";
    if (awayHours>=24-1e-6) { dayType="FULL"; amount=rate?.full_day_eur||0; reason="full day away from home base"; }
    else if (awayHours>8) { dayType="HALF"; amount=rate?.eight_plus_eur||0; reason=">8h away from home base"; }
    if (!rate && dayType!=="NONE") reason += " — rate not found";
    const breakfast=!!breakfastByDate[date] && amount>0 && !!rate;
    if (breakfast && rate) { amount=Math.max(0,amount-0.2*rate.full_day_eur); reason += " + breakfast −20%"; }
    items.push({
      date,
      startUtc:isoMinute(first.start), endUtc:isoMinute(last.end), awayHours,
      from:first.from, to:last.to, rateLocation:rateLoc,
      dayType, perDiemEUR:amount, breakfastApplied:breakfast, reason,
    });
  }
  return {items,warnings};
}

// Lightweight regression tests for the agreed rules.
(function runSelfTests(){
  try {
    const sampleRates:Rate[]=[
      {country:"Germany",city:"Hannover",full_day_eur:50,eight_plus_eur:25},
      {country:"Italy",city:"Olbia",full_day_eur:60,eight_plus_eur:30},
      {country:"Spain",city:"Palma",full_day_eur:70,eight_plus_eur:35},
      {country:"France",city:"Paris",full_day_eur:65,eight_plus_eur:32.5},
    ];
    const homes=[{country:"Germany",city:"Berlin"},{country:"Poland",city:"Warsaw"}];
    const legs19:Leg[]=[
      {id:"1",startUtc:"2026-08-19T08:00",endUtc:"2026-08-19T09:40",from:homes[0],to:{country:"France",city:"Paris"}},
      {id:"2",startUtc:"2026-08-19T11:00",endUtc:"2026-08-19T12:40",from:{country:"France",city:"Paris"},to:{country:"Italy",city:"Olbia"}},
      {id:"3",startUtc:"2026-08-20T08:10",endUtc:"2026-08-20T11:10",from:{country:"Italy",city:"Olbia"},to:{country:"Greece",city:"Athens"}},
      {id:"4",startUtc:"2026-08-20T11:50",endUtc:"2026-08-20T13:55",from:{country:"Greece",city:"Athens"},to:{country:"Spain",city:"Palma"}},
      {id:"5",startUtc:"2026-08-21T08:00",endUtc:"2026-08-21T17:00",from:{country:"Spain",city:"Palma"},to:homes[0]},
    ];
    const t=buildDailyPerDiems(legs19,sampleRates,homes,{}).items;
    console.assert(t[0]?.rateLocation.city==="Olbia","19 Aug should use Olbia");
    console.assert(t[1]?.rateLocation.city==="Palma","20 Aug should use Palma");
    console.assert(t[1]?.from.city==="Olbia" && t[1]?.to.city==="Palma","movement day should be Olbia→Palma");
    console.assert(t[2]?.rateLocation.city==="Palma","return day should use last non-home location, not BER");
    console.assert(new Set(t.map(x=>x.date)).size===t.length,"only one per-diem result per date");
  } catch {}
})();

export default function App(){
  const [rates,setRates]=useState<Rate[]>(emptyRates);
  const [ratesStatus,setRatesStatus]=useState<"idle"|"loading"|"loaded"|"error">("idle");
  const ccMap=useMemo(()=>buildCountryCityMap(rates),[rates]);
  const allCountries=useMemo(()=>countryListFromMap(ccMap),[ccMap]);
  const cityList=(c:string)=>citiesFor(ccMap,c);

  const [employees,setEmployees]=useState<Employee[]>(defaultEmployees);
  const [selectedEmpId,setSelectedEmpId]=useState(defaultEmployees[0].id);
  const selectedEmp=employees.find(e=>e.id===selectedEmpId)||null;
  const [empPanelOpen,setEmpPanelOpen]=useState(false);
  const [empForm,setEmpForm]=useState<Employee>({id:"",name:"",basePrimary:{country:"Germany",city:"Berlin"},baseSecondary:{country:"Poland",city:"Warsaw"}});
  const [month,setMonth]=useState(()=>{const d=new Date();return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;});

  const makeDefaultLeg=():Leg=>{
    const id=(globalThis as any).crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
    const d=new Date(); const ds=isoDate(d);
    const base=selectedEmp?.basePrimary||{country:"Germany",city:"Berlin"};
    return {id,startUtc:`${ds}T00:00`,endUtc:`${ds}T23:59`,from:{...base},to:{...base}};
  };
  const [legs,setLegs]=useState<Leg[]>([makeDefaultLeg()]);
  const [breakfastByDate,setBreakfastByDate]=useState<Record<string,boolean>>({});
  const previewRef=useRef<HTMLDivElement>(null);

  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      try{const raw=localStorage.getItem(LS_RATES_KEY);if(raw){const arr=JSON.parse(raw);if(Array.isArray(arr)&&arr.length){setRates(arr);setRatesStatus("loaded");return;}}}catch{}
      setRatesStatus("loading");
      for(const url of DEFAULT_RATE_CANDIDATES){try{const res=await fetch(url,{cache:"no-store"});if(!res.ok)continue;const cleaned=normalizeRates(await res.json());if(cleaned.length&&!cancelled){setRates(cleaned);setRatesStatus("loaded");try{localStorage.setItem(LS_RATES_KEY,JSON.stringify(cleaned));}catch{}return;}}catch{}}
      if(!cancelled)setRatesStatus("error");
    })();
    return()=>{cancelled=true};
  },[]);

  useEffect(()=>{try{const raw=localStorage.getItem(LS_EMPLOYEES_KEY);if(raw){const arr=JSON.parse(raw);if(Array.isArray(arr)&&arr.length){setEmployees(arr);if(!arr.some((e:Employee)=>e.id===selectedEmpId))setSelectedEmpId(arr[0].id);}}}catch{}},[]);
  useEffect(()=>{try{localStorage.setItem(LS_EMPLOYEES_KEY,JSON.stringify(employees));}catch{}},[employees]);
  useEffect(()=>{try{const raw=localStorage.getItem(LS_TRIPS_KEY);if(raw){const p=JSON.parse(raw);if(Array.isArray(p.legs))setLegs(p.legs);if(p.breakfastByDate&&typeof p.breakfastByDate==="object")setBreakfastByDate(p.breakfastByDate);}}catch{}},[]);
  useEffect(()=>{try{localStorage.setItem(LS_TRIPS_KEY,JSON.stringify({legs,breakfastByDate}));}catch{}},[legs,breakfastByDate]);

  function onUploadRatesFile(file:File){const r=new FileReader();r.onload=()=>{try{const text=String(r.result||"");const parsed=/^\s*[\[{]/.test(text)?normalizeRates(JSON.parse(text)):parseCSV(text);setRates(parsed);setRatesStatus("loaded");try{localStorage.setItem(LS_RATES_KEY,JSON.stringify(parsed));}catch{}}catch{alert("Failed to parse rates file");}};r.readAsText(file);}
  function addOrUpdateEmployee(){const id=empForm.id.toUpperCase();if(!/^[A-Z]{3}$/.test(id)){alert("Employee ID must be exactly 3 letters");return;}const entry={...empForm,id,name:empForm.name.trim()||id};setEmployees(prev=>{const n=prev.some(e=>e.id===id)?prev.map(e=>e.id===id?entry:e):[...prev,entry];return n.sort((a,b)=>a.id.localeCompare(b.id));});setSelectedEmpId(id);setEmpPanelOpen(false);}
  function exportEmployeesJSON(){const blob=new Blob([JSON.stringify(employees,null,2)],{type:"application/json"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download="employees.json";a.click();URL.revokeObjectURL(url);}
  function onImportEmployeesFile(file:File){const r=new FileReader();r.onload=()=>{try{const arr=JSON.parse(String(r.result||""));if(!Array.isArray(arr))throw 0;const cleaned:Employee[]=arr.filter((e:any)=>/^[A-Z]{3}$/.test(String(e?.id||"").toUpperCase())).map((e:any)=>({id:String(e.id).toUpperCase(),name:String(e.name||e.id),basePrimary:{country:String(e?.basePrimary?.country||""),city:String(e?.basePrimary?.city||"")},baseSecondary:{country:String(e?.baseSecondary?.country||""),city:String(e?.baseSecondary?.city||"")}}));if(!cleaned.length)throw 0;setEmployees(cleaned);setSelectedEmpId(cleaned[0].id);}catch{alert("Invalid employees JSON");}};r.readAsText(file);}

  function addLeg(){setLegs(l=>[...l,makeDefaultLeg()]);}
  function addNextLeg(){setLegs(l=>{const last=l[l.length-1];if(!last)return[makeDefaultLeg()];const id=(globalThis as any).crypto?.randomUUID?.()||Math.random().toString(36).slice(2);const start=last.endUtc;const d=new Date(start+":00Z");const endUtc=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),23,59)).toISOString().slice(0,16);return[...l,{id,startUtc:start,endUtc,from:{...last.to},to:{...last.from}}];});}
  function removeLeg(id:string){setLegs(l=>l.filter(x=>x.id!==id));}

  const calc=useMemo(()=>buildDailyPerDiems(legs,rates,homeBasesFor(selectedEmp),breakfastByDate),[legs,rates,selectedEmp,breakfastByDate]);
  const totalEUR=calc.items.reduce((s,it)=>s+it.perDiemEUR,0);

  function exportCSV(){const rows:string[][]=[["date","start_utc","end_utc","from","to","rate_country","rate_city","day_type","away_hours","breakfast","per_diem_eur"]];for(const it of calc.items)rows.push([it.date,it.startUtc,it.endUtc,locLabel(it.from),locLabel(it.to),it.rateLocation.country,it.rateLocation.city,it.dayType,it.awayHours.toFixed(2),it.breakfastApplied?"yes":"no",it.perDiemEUR.toFixed(2)]);const blob=new Blob([toCSV(rows)],{type:"text/csv;charset=utf-8"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`per_diem_${selectedEmp?.id||"EMP"}_${month}.csv`;a.click();URL.revokeObjectURL(url);}

  async function exportPDF(){
    try{
      const node=previewRef.current;if(!node){alert("Preview not ready");return;}
      const [html2canvasMod,jsPDFMod]=await Promise.all([import(/* @vite-ignore */ "html2canvas"),import(/* @vite-ignore */ "jspdf")]);
      const html2canvas=(html2canvasMod as any).default||html2canvasMod;const {jsPDF}=jsPDFMod as any;
      const pdf=new jsPDF({orientation:"p",unit:"pt",format:"a4"});const pw=pdf.internal.pageSize.getWidth();const ph=pdf.internal.pageSize.getHeight();const margin=28;let y=margin;
      let logo:string|null=null;try{const res=await fetch(DEFAULT_LOGO_URL,{cache:"no-store"});if(res.ok){const blob=await res.blob();logo=await new Promise<string>(resolve=>{const fr=new FileReader();fr.onload=()=>resolve(String(fr.result));fr.readAsDataURL(blob);});}}catch{}
      if(logo)pdf.addImage(logo,"PNG",margin,y,108,36);
      pdf.setFontSize(12);pdf.text(`Employee: ${selectedEmp?.id||""}${selectedEmp?.name?" — "+selectedEmp.name:""}`,pw-margin,y+14,{align:"right"});pdf.text(`Month: ${month}`,pw-margin,y+30,{align:"right"});pdf.text(`Total per-diem: EUR ${totalEUR.toFixed(2)}`,pw-margin,y+46,{align:"right"});y+=58;pdf.setDrawColor(200);pdf.line(margin,y,pw-margin,y);y+=10;
      const canvas=await html2canvas(node,{scale:2,useCORS:true,backgroundColor:"#fff"});const imgW=pw-margin*2;const space=ph-y-margin;const sliceH=Math.max(1,Math.floor(canvas.width*(space/imgW)));let pos=0;while(pos<canvas.height){const slice=document.createElement("canvas");slice.width=canvas.width;slice.height=Math.min(sliceH,canvas.height-pos);slice.getContext("2d")!.drawImage(canvas,0,pos,canvas.width,slice.height,0,0,canvas.width,slice.height);if(pos>0){pdf.addPage();y=margin;}pdf.addImage(slice.toDataURL("image/png"),"PNG",margin,y,imgW,slice.height*(imgW/canvas.width));pos+=sliceH;}pdf.save(`per_diem_${selectedEmp?.id||"EMP"}_${month}.pdf`);
    }catch(err){console.error(err);alert("PDF export failed. Make sure html2canvas and jspdf are installed.");}
  }

  return <div className="mx-auto max-w-6xl p-4 space-y-4">
    <div className="flex items-center gap-4">
      <img src={DEFAULT_LOGO_URL} alt="Logo" className="h-10 w-auto"/>
      <Card className="flex-1"><CardContent>
        <div className="flex items-end gap-3 flex-wrap">
          <div><label className="mb-1 block text-sm font-medium">Employee</label><select className="w-[220px] rounded-xl border px-3 py-2 text-sm" value={selectedEmpId} onChange={e=>setSelectedEmpId(e.target.value)}>{employees.map(e=><option key={e.id} value={e.id}>{e.id} — {e.name}</option>)}</select></div>
          <Button variant="outline" className="gap-2" onClick={()=>setEmpPanelOpen(v=>!v)}><IconEdit className="h-4 w-4"/> Add / Edit employee</Button>
          <Button variant="outline" onClick={exportEmployeesJSON}>Export employees</Button>
          <label className="text-sm cursor-pointer"><input type="file" accept="application/json" className="hidden" onChange={e=>{const f=e.target.files?.[0];if(f)onImportEmployeesFile(f);}}/><span>Import employees</span></label>
          <div className="grow"/><label className="mb-1 block text-sm font-medium">Month</label><input type="month" className="rounded-xl border px-3 py-2 text-sm" value={month} onChange={e=>setMonth(e.target.value)}/>
        </div>
        {empPanelOpen && <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div><label className="mb-1 block text-sm font-medium">Employee ID (3 letters)</label><Input value={empForm.id} maxLength={3} onChange={e=>setEmpForm({...empForm,id:e.target.value.toUpperCase()})}/></div>
          <div><label className="mb-1 block text-sm font-medium">Employee Name</label><Input value={empForm.name} onChange={e=>setEmpForm({...empForm,name:e.target.value})}/></div>
          <div><label className="mb-1 block text-sm font-medium">Primary Base — Country</label><Input value={empForm.basePrimary.country} onChange={e=>setEmpForm({...empForm,basePrimary:{...empForm.basePrimary,country:e.target.value}})}/></div>
          <div><label className="mb-1 block text-sm font-medium">Primary Base — City</label><Input value={empForm.basePrimary.city} onChange={e=>setEmpForm({...empForm,basePrimary:{...empForm.basePrimary,city:e.target.value}})}/></div>
          <div className="md:col-span-2 border-t pt-3"><details><summary className="cursor-pointer text-sm font-medium">Secondary Home Base (optional)</summary><div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
            <select className="rounded-xl border px-3 py-2 text-sm" value={empForm.baseSecondary.country} onChange={e=>{const c=e.target.value;setEmpForm({...empForm,baseSecondary:{country:c,city:cityList(c)[0]||""}});}}><option value="">— None —</option>{allCountries.map(c=><option key={c}>{c}</option>)}</select>
            <select className="rounded-xl border px-3 py-2 text-sm" value={empForm.baseSecondary.city} onChange={e=>setEmpForm({...empForm,baseSecondary:{...empForm.baseSecondary,city:selectValueToCity(e.target.value)}})}><option value="">— None —</option>{empForm.baseSecondary.country && ["",...cityList(empForm.baseSecondary.country)].map(c=><option key={c||CITY_COUNTRY_ONLY_SENTINEL} value={cityToSelectValue(c)}>{c||"(Country rate)"}</option>)}</select>
          </div></details></div>
          <div className="md:col-span-2"><Button onClick={addOrUpdateEmployee}>Save Employee</Button></div>
        </div>}
      </CardContent></Card>
    </div>

    <div className="flex items-center gap-3 flex-wrap">
      <Card className="p-3 flex items-center gap-3"><Badge>rates: {ratesStatus}</Badge><label className="text-sm cursor-pointer"><input type="file" accept=".json,.csv" className="hidden" onChange={e=>{const f=e.target.files?.[0];if(f)onUploadRatesFile(f);}}/><span className="inline-flex items-center gap-2"><IconUpload className="h-4 w-4"/> Load rates</span></label></Card>
      <div className="grow"/><Button variant="outline" onClick={exportCSV}>Export CSV</Button><Button variant="outline" onClick={exportPDF}>Export PDF</Button>
    </div>

    <Card><CardHeader className="flex items-center justify-between"><CardTitle>Trip Legs (UTC)</CardTitle><div className="flex gap-2"><Button variant="secondary" className="gap-2" onClick={addLeg}><IconPlus className="h-4 w-4"/> Add new leg</Button><Button variant="secondary" className="gap-2" onClick={addNextLeg}><IconPlus className="h-4 w-4"/> Next leg</Button></div></CardHeader>
      <CardContent className="space-y-3">{legs.map(leg=>{const invalid=new Date(leg.startUtc+":00Z")>=new Date(leg.endUtc+":00Z");return <div key={leg.id} className="grid grid-cols-1 lg:grid-cols-12 gap-2 items-end">
        <div className="lg:col-span-2"><label className="text-xs block">Start UTC</label><input type="datetime-local" step={300} className={`w-full rounded-xl border px-3 py-2 text-sm ${invalid?"border-red-500":""}`} value={leg.startUtc} onChange={e=>setLegs(ls=>ls.map(x=>x.id===leg.id?{...x,startUtc:e.target.value}:x))}/></div>
        <div className="lg:col-span-2"><label className="text-xs block">End UTC</label><input type="datetime-local" step={300} className={`w-full rounded-xl border px-3 py-2 text-sm ${invalid?"border-red-500":""}`} value={leg.endUtc} onChange={e=>setLegs(ls=>ls.map(x=>x.id===leg.id?{...x,endUtc:e.target.value}:x))}/></div>
        <div className="lg:col-span-2"><label className="text-xs block">From — Country</label><select className="w-full rounded-xl border px-3 py-2 text-sm" value={leg.from.country} onChange={e=>{const c=e.target.value;setLegs(ls=>ls.map(x=>x.id===leg.id?{...x,from:{country:c,city:cityList(c)[0]||""}}:x));}}>{allCountries.map(c=><option key={c}>{c}</option>)}</select></div>
        <div className="lg:col-span-1"><label className="text-xs block">From — City</label><select className="w-full rounded-xl border px-3 py-2 text-sm" value={cityToSelectValue(leg.from.city)} onChange={e=>setLegs(ls=>ls.map(x=>x.id===leg.id?{...x,from:{...x.from,city:selectValueToCity(e.target.value)}}:x))}>{["",...cityList(leg.from.country)].map(c=><option key={c||CITY_COUNTRY_ONLY_SENTINEL} value={cityToSelectValue(c)}>{c||"(Country rate)"}</option>)}</select></div>
        <div className="lg:col-span-2"><label className="text-xs block">To — Country</label><select className="w-full rounded-xl border px-3 py-2 text-sm" value={leg.to.country} onChange={e=>{const c=e.target.value;setLegs(ls=>ls.map(x=>x.id===leg.id?{...x,to:{country:c,city:cityList(c)[0]||""}}:x));}}>{allCountries.map(c=><option key={c}>{c}</option>)}</select></div>
        <div className="lg:col-span-1"><label className="text-xs block">To — City</label><select className="w-full rounded-xl border px-3 py-2 text-sm" value={cityToSelectValue(leg.to.city)} onChange={e=>setLegs(ls=>ls.map(x=>x.id===leg.id?{...x,to:{...x.to,city:selectValueToCity(e.target.value)}}:x))}>{["",...cityList(leg.to.country)].map(c=><option key={c||CITY_COUNTRY_ONLY_SENTINEL} value={cityToSelectValue(c)}>{c||"(Country rate)"}</option>)}</select></div>
        <div className="lg:col-span-2 flex items-center justify-end gap-2">{invalid&&<span className="text-xs text-red-600">Start must be earlier than End</span>}<Button variant="outline" className="gap-2" onClick={()=>removeLeg(leg.id)}><IconTrash className="h-4 w-4"/> Remove</Button></div>
      </div>})}</CardContent>
    </Card>

    <Card><CardHeader><CardTitle>Calculation Preview</CardTitle></CardHeader><CardContent className="overflow-x-auto" ref={previewRef}>
      <table className="w-full text-sm"><thead><tr className="text-left border-b"><th className="py-2">Day (UTC)</th><th>Start</th><th>End</th><th>From</th><th>To</th><th>Rate location</th><th>Type</th><th>Breakfast</th><th>Per-Diem (€)</th><th>Reason</th></tr></thead><tbody>
        {calc.items.map(it=>{const full=it.dayType==="FULL";return <tr key={it.date} className="border-b last:border-0"><td className="py-2">{it.date}</td><td>{full?"full day":hhmm(it.startUtc)}</td><td>{full?"full day":hhmm(it.endUtc)}</td><td>{locLabel(it.from)}</td><td>{locLabel(it.to)}</td><td className="font-medium">{locLabel(it.rateLocation)}</td><td>{it.dayType}</td><td><input type="checkbox" checked={!!breakfastByDate[it.date]} onChange={e=>setBreakfastByDate(prev=>({...prev,[it.date]:e.target.checked}))}/></td><td className="font-medium">{it.perDiemEUR.toFixed(2)}</td><td className="text-neutral-500">{it.reason}</td></tr>})}
      </tbody></table>
      {calc.warnings.length>0&&<div className="mt-3 text-xs text-amber-700">{calc.warnings.map((w,i)=><div key={i}>• {w}</div>)}</div>}
      <div className="mt-3 flex justify-end"><div className="rounded-xl border px-3 py-2 bg-neutral-50 text-sm"><span className="mr-2 font-medium">Total per-diem:</span><span className="font-semibold">€ {totalEUR.toFixed(2)}</span></div></div>
    </CardContent></Card>
  </div>;
}
