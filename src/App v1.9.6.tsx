import React, { useEffect, useMemo, useRef, useState } from "react";

function Card(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={"rounded-2xl border border-slate-200/80 shadow-sm bg-white/95 backdrop-blur-sm " + (props.className || "")} />;
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
    default: "bg-slate-900 text-white hover:bg-slate-800",
    outline: "border border-slate-300 bg-white hover:bg-slate-50 text-slate-800",
    secondary: "bg-slate-100 text-slate-800 hover:bg-slate-200",
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
type MovementType = "FLIGHT" | "TRV" | "MANUAL";
type Leg = { id: string; startUtc: string; endUtc: string; from: Location; to: Location; movementType?: MovementType; source?: "ICS" | "MANUAL"; label?: string };
type ParsedIcsEvent = {
  kind: "FLIGHT" | "TRV" | "ON" | "OTHER";
  summary: string;
  startUtc: string;
  endUtc: string;
  locationText: string;
  fromIcao?: string;
  toIcao?: string;
  from?: Location;
  to?: Location;
};
type RawIcsDiagnostics = {
  eventCount: number;
  rawFrom: string;
  rawTo: string;
  rawTimedFrom: string;
  rawTimedTo: string;
  allDayCount: number;
  parsedTimedCount: number;
  unparsedTimedCount: number;
  selectedRawTimedEvents: Array<{date:string; summary:string; rawStart:string}>;
};
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
const LS_RATES_YEAR_KEY = "perdiem_rates_year_v1";
const LS_TRIPS_KEY = "perdiem_trips_v2";
const LS_EMPLOYEES_KEY = "perdiem_employees_v1";
const LS_FL3XX_SETTINGS_KEY = "perdiem_fl3xx_settings_v1";
const LS_FL3XX_ARCHIVE_KEY = "perdiem_fl3xx_archive_v1";
const LS_FL3XX_HIDDEN_KEY = "perdiem_fl3xx_hidden_v1";
const DEFAULT_FL3XX_PROXY_URL = "https://fl3xx-perdiem-proxy.triplezulu.workers.dev/";

const SAFE_BASE_URL: string = (() => {
  try {
    // @ts-ignore
    const b = (import.meta && (import.meta as any).env && (import.meta as any).env.BASE_URL) || "/";
    return typeof b === "string" ? (b.endsWith("/") ? b : b + "/") : "/";
  } catch { return "/"; }
})();
const DEFAULT_LOGO_URL = SAFE_BASE_URL + "logo.png";
const rateCandidatesForYear=(year:number)=>[SAFE_BASE_URL + `per_diem_${year}.json`, `/per_diem_${year}.json`];

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
const COUNTRY_ISO2:Record<string,string>={"Afghanistan":"AF","Albania":"AL","Algeria":"DZ","American Samoa":"AS","Andorra":"AD","Angola":"AO","Anguilla":"AI","Antarctica":"AQ","Antigua and Barbuda":"AG","Arab Republic of Egypt":"EG","Argentina":"AR","Argentine Republic":"AR","Armenia":"AM","Aruba":"AW","Australia":"AU","Austria":"AT","Azerbaijan":"AZ","Bahamas":"BS","Bahrain":"BH","Bangladesh":"BD","Barbados":"BB","Belarus":"BY","Belgium":"BE","Belize":"BZ","Benin":"BJ","Bermuda":"BM","Bhutan":"BT","Bolivarian Republic of Venezuela":"VE","Bolivia":"BO","Bolivia, Plurinational State of":"BO","Bonaire, Sint Eustatius and Saba":"BQ","Bosnia and Herzegovina":"BA","Botswana":"BW","Bouvet Island":"BV","Brazil":"BR","British Indian Ocean Territory":"IO","British Virgin Islands":"VG","Brunei":"BN","Brunei Darussalam":"BN","Bulgaria":"BG","Burkina Faso":"BF","Burundi":"BI","Cabo Verde":"CV","Cambodia":"KH","Cameroon":"CM","Canada":"CA","Cape Verde":"CV","Cayman Islands":"KY","Central African Republic":"CF","Chad":"TD","Chile":"CL","China":"CN","Christmas Island":"CX","Cocos (Keeling) Islands":"CC","Colombia":"CO","Commonwealth of Dominica":"DM","Commonwealth of the Bahamas":"BS","Commonwealth of the Northern Mariana Islands":"MP","Comoros":"KM","Congo":"CG","Congo, Democratic Republic of":"CD","Congo, Republic of":"CG","Congo, The Democratic Republic of the":"CD","Cook Islands":"CK","Costa Rica":"CR","Croatia":"HR","Cuba":"CU","Curaçao":"CW","Cyprus":"CY","Czech Republic":"CZ","Czechia":"CZ","Côte d'Ivoire":"CI","Côte d’Ivoire":"CI","Democratic People's Republic of Korea":"KP","Democratic Republic of Sao Tome and Principe":"ST","Democratic Republic of Timor-Leste":"TL","Democratic Socialist Republic of Sri Lanka":"LK","Denmark":"DK","Djibouti":"DJ","Dominica":"DM","Dominican Republic":"DO","Eastern Republic of Uruguay":"UY","Ecuador":"EC","Egypt":"EG","El Salvador":"SV","Equatorial Guinea":"GQ","Eritrea":"ER","Estonia":"EE","Eswatini":"SZ","Ethiopia":"ET","Falkland Islands (Malvinas)":"FK","Faroe Islands":"FO","Federal Democratic Republic of Ethiopia":"ET","Federal Democratic Republic of Nepal":"NP","Federal Republic of Germany":"DE","Federal Republic of Nigeria":"NG","Federal Republic of Somalia":"SO","Federated States of Micronesia":"FM","Federative Republic of Brazil":"BR","Fiji":"FJ","Finland":"FI","France":"FR","French Guiana":"GF","French Polynesia":"PF","French Republic":"FR","French Southern Territories":"TF","Gabon":"GA","Gabonese Republic":"GA","Gambia":"GM","Georgia":"GE","Germany":"DE","Ghana":"GH","Gibraltar":"GI","Grand Duchy of Luxembourg":"LU","Greece":"GR","Greenland":"GL","Grenada":"GD","Guadeloupe":"GP","Guam":"GU","Guatemala":"GT","Guernsey":"GG","Guinea":"GN","Guinea-Bissau":"GW","Guyana":"GY","Haiti":"HT","Hashemite Kingdom of Jordan":"JO","Heard Island and McDonald Islands":"HM","Hellenic Republic":"GR","Holy See (Vatican City State)":"VA","Honduras":"HN","Hong Kong":"HK","Hong Kong Special Administrative Region of China":"HK","Hungary":"HU","Iceland":"IS","Independent State of Papua New Guinea":"PG","Independent State of Samoa":"WS","India":"IN","Indonesia":"ID","Iran":"IR","Iran, Islamic Republic of":"IR","Iraq":"IQ","Ireland":"IE","Islamic Republic of Afghanistan":"AF","Islamic Republic of Iran":"IR","Islamic Republic of Mauritania":"MR","Islamic Republic of Pakistan":"PK","Isle of Man":"IM","Israel":"IL","Italian Republic":"IT","Italy":"IT","Jamaica":"JM","Japan":"JP","Jersey":"JE","Jordan":"JO","Kazakhstan":"KZ","Kenya":"KE","Kingdom of Bahrain":"BH","Kingdom of Belgium":"BE","Kingdom of Bhutan":"BT","Kingdom of Cambodia":"KH","Kingdom of Denmark":"DK","Kingdom of Eswatini":"SZ","Kingdom of Lesotho":"LS","Kingdom of Morocco":"MA","Kingdom of Norway":"NO","Kingdom of Saudi Arabia":"SA","Kingdom of Spain":"ES","Kingdom of Sweden":"SE","Kingdom of Thailand":"TH","Kingdom of Tonga":"TO","Kingdom of the Netherlands":"NL","Kiribati":"KI","Korea, Democratic People's Republic":"KP","Korea, Democratic People's Republic of":"KP","Korea, Republic of":"KR","Kuwait":"KW","Kyrgyz Republic":"KG","Kyrgyzstan":"KG","Lao People's Democratic Republic":"LA","Laos":"LA","Latvia":"LV","Lebanese Republic":"LB","Lebanon":"LB","Lesotho":"LS","Liberia":"LR","Libya":"LY","Liechtenstein":"LI","Lithuania":"LT","Luxembourg":"LU","Macao":"MO","Macao Special Administrative Region of China":"MO","Madagascar":"MG","Malawi":"MW","Malaysia":"MY","Maldives":"MV","Mali":"ML","Malta":"MT","Marshall Islands":"MH","Martinique":"MQ","Mauritania":"MR","Mauritius":"MU","Mayotte":"YT","Mexico":"MX","Micronesia, Federated States of":"FM","Moldova":"MD","Moldova, Republic of":"MD","Monaco":"MC","Mongolia":"MN","Montenegro":"ME","Montserrat":"MS","Morocco":"MA","Mozambique":"MZ","Myanmar":"MM","Namibia":"NA","Nauru":"NR","Nepal":"NP","Netherlands":"NL","New Caledonia":"NC","New Zealand":"NZ","Nicaragua":"NI","Niger":"NE","Nigeria":"NG","Niue":"NU","Norfolk Island":"NF","North Korea":"KP","North Macedonia":"MK","Northern Mariana Islands":"MP","Norway":"NO","Oman":"OM","Pakistan":"PK","Palau":"PW","Palestine, State of":"PS","Palestinian Territories":"PS","Panama":"PA","Papua New Guinea":"PG","Paraguay":"PY","People's Democratic Republic of Algeria":"DZ","People's Republic of Bangladesh":"BD","People's Republic of China":"CN","Peru":"PE","Philippines":"PH","Pitcairn":"PN","Plurinational State of Bolivia":"BO","Poland":"PL","Portugal":"PT","Portuguese Republic":"PT","Principality of Andorra":"AD","Principality of Liechtenstein":"LI","Principality of Monaco":"MC","Puerto Rico":"PR","Qatar":"QA","Republic of Albania":"AL","Republic of Angola":"AO","Republic of Armenia":"AM","Republic of Austria":"AT","Republic of Azerbaijan":"AZ","Republic of Belarus":"BY","Republic of Benin":"BJ","Republic of Bosnia and Herzegovina":"BA","Republic of Botswana":"BW","Republic of Bulgaria":"BG","Republic of Burundi":"BI","Republic of Cabo Verde":"CV","Republic of Cameroon":"CM","Republic of Chad":"TD","Republic of Chile":"CL","Republic of Colombia":"CO","Republic of Costa Rica":"CR","Republic of Croatia":"HR","Republic of Cuba":"CU","Republic of Cyprus":"CY","Republic of Côte d'Ivoire":"CI","Republic of Djibouti":"DJ","Republic of Ecuador":"EC","Republic of El Salvador":"SV","Republic of Equatorial Guinea":"GQ","Republic of Estonia":"EE","Republic of Fiji":"FJ","Republic of Finland":"FI","Republic of Ghana":"GH","Republic of Guatemala":"GT","Republic of Guinea":"GN","Republic of Guinea-Bissau":"GW","Republic of Guyana":"GY","Republic of Haiti":"HT","Republic of Honduras":"HN","Republic of Iceland":"IS","Republic of India":"IN","Republic of Indonesia":"ID","Republic of Iraq":"IQ","Republic of Kazakhstan":"KZ","Republic of Kenya":"KE","Republic of Kiribati":"KI","Republic of Latvia":"LV","Republic of Liberia":"LR","Republic of Lithuania":"LT","Republic of Madagascar":"MG","Republic of Malawi":"MW","Republic of Maldives":"MV","Republic of Mali":"ML","Republic of Malta":"MT","Republic of Mauritius":"MU","Republic of Moldova":"MD","Republic of Mozambique":"MZ","Republic of Myanmar":"MM","Republic of Namibia":"NA","Republic of Nauru":"NR","Republic of Nicaragua":"NI","Republic of North Macedonia":"MK","Republic of Palau":"PW","Republic of Panama":"PA","Republic of Paraguay":"PY","Republic of Peru":"PE","Republic of Poland":"PL","Republic of San Marino":"SM","Republic of Senegal":"SN","Republic of Serbia":"RS","Republic of Seychelles":"SC","Republic of Sierra Leone":"SL","Republic of Singapore":"SG","Republic of Slovenia":"SI","Republic of South Africa":"ZA","Republic of South Sudan":"SS","Republic of Suriname":"SR","Republic of Tajikistan":"TJ","Republic of Trinidad and Tobago":"TT","Republic of Tunisia":"TN","Republic of Türkiye":"TR","Republic of Uganda":"UG","Republic of Uzbekistan":"UZ","Republic of Vanuatu":"VU","Republic of Yemen":"YE","Republic of Zambia":"ZM","Republic of Zimbabwe":"ZW","Republic of the Congo":"CG","Republic of the Gambia":"GM","Republic of the Marshall Islands":"MH","Republic of the Niger":"NE","Republic of the Philippines":"PH","Republic of the Sudan":"SD","Romania":"RO","Russia":"RU","Russian Federation":"RU","Rwanda":"RW","Rwandese Republic":"RW","Réunion":"RE","Saint Barthélemy":"BL","Saint Helena, Ascension and Tristan da Cunha":"SH","Saint Kitts and Nevis":"KN","Saint Lucia":"LC","Saint Martin (French part)":"MF","Saint Pierre and Miquelon":"PM","Saint Vincent and the Grenadines":"VC","Samoa":"WS","San Marino":"SM","Sao Tome and Principe":"ST","Saudi Arabia":"SA","Senegal":"SN","Serbia":"RS","Seychelles":"SC","Sierra Leone":"SL","Singapore":"SG","Sint Maarten (Dutch part)":"SX","Slovak Republic":"SK","Slovakia":"SK","Slovenia":"SI","Socialist Republic of Viet Nam":"VN","Solomon Islands":"SB","Somalia":"SO","South Africa":"ZA","South Georgia and the South Sandwich Islands":"GS","South Korea":"KR","South Sudan":"SS","Spain":"ES","Sri Lanka":"LK","State of Israel":"IL","State of Kuwait":"KW","State of Qatar":"QA","Sudan":"SD","Sultanate of Oman":"OM","Suriname":"SR","Svalbard and Jan Mayen":"SJ","Sweden":"SE","Swiss Confederation":"CH","Switzerland":"CH","Syria":"SY","Syrian Arab Republic":"SY","São Tomé and Príncipe":"ST","Taiwan":"TW","Taiwan, Province of China":"TW","Tajikistan":"TJ","Tanzania":"TZ","Tanzania, United Republic of":"TZ","Thailand":"TH","Timor-Leste":"TL","Togo":"TG","Togolese Republic":"TG","Tokelau":"TK","Tonga":"TO","Trinidad and Tobago":"TT","Tunisia":"TN","Turkmenistan":"TM","Turks and Caicos Islands":"TC","Tuvalu":"TV","Türkiye":"TR","Uganda":"UG","Ukraine":"UA","Union of the Comoros":"KM","United Arab Emirates":"AE","United Kingdom":"GB","United Kingdom of Great Britain and Northern Ireland":"GB","United Mexican States":"MX","United Republic of Tanzania":"TZ","United States":"US","United States Minor Outlying Islands":"UM","United States of America":"US","Uruguay":"UY","Uzbekistan":"UZ","Vanuatu":"VU","Vatican City":"VA","Venezuela":"VE","Venezuela, Bolivarian Republic of":"VE","Viet Nam":"VN","Vietnam":"VN","Virgin Islands of the United States":"VI","Virgin Islands, British":"VG","Virgin Islands, U.S.":"VI","Wallis and Futuna":"WF","Western Sahara":"EH","Yemen":"YE","Zambia":"ZM","Zimbabwe":"ZW","the State of Eritrea":"ER","the State of Palestine":"PS","Åland Islands":"AX"};
const countryCode=(country:string)=>COUNTRY_ISO2[country]||country.slice(0,2).toUpperCase();
const compactLocLabel=(l:Location)=>{
  const code=countryCode(l.country);
  const city=(l.city||"").trim();
  return city && city!=="Other" ? `${code} · ${city}` : code;
};
const compactReason=(it:DailyPerDiem)=>{
  const base=it.dayType==="FULL"?"Full day":it.dayType==="HALF"?">8h":"≤8h";
  return it.breakfastApplied ? `${base} · breakfast −20%` : base;
};
const isoDate=(d:Date)=>`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
const isoMinute=(d:Date)=>d.toISOString().slice(0,16);
const hhmm=(iso:string)=>iso.slice(11,16);
function defaultReportMonth(){
  const now=new Date();
  const y=now.getFullYear(), m=now.getMonth();
  const lastDay=new Date(y,m+1,0).getDate();
  const useCurrent=now.getDate()===lastDay;
  const d=useCurrent ? new Date(y,m,1) : new Date(y,m-1,1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}
function monthDateBounds(month:string){
  const m=month.match(/^(\d{4})-(\d{2})$/);
  if(!m){ const d=new Date(); const ds=isoDate(d); return {from:ds,to:ds}; }
  const y=Number(m[1]), mo=Number(m[2]);
  const last=new Date(Date.UTC(y,mo,0)).getUTCDate();
  return {from:`${m[1]}-${m[2]}-01`,to:`${m[1]}-${m[2]}-${String(last).padStart(2,"0")}`};
}
function eventOverlapsDateRange(e:ParsedIcsEvent, fromDate:string, toDate:string){
  if(!e.startUtc || !e.endUtc) return false;
  const fromMs=new Date(`${fromDate}T00:00:00Z`).getTime();
  const toMs=new Date(`${toDate}T23:59:59Z`).getTime();
  const startMs=new Date(e.startUtc+":00Z").getTime();
  const endMs=new Date(e.endUtc+":00Z").getTime();
  return endMs>=fromMs && startMs<=toMs;
}
function shiftIsoDate(date:string,days:number){
  const d=new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate()+days);
  return isoDate(d);
}
function expandedContextRange(fromDate:string,toDate:string,days=7){
  return {from:shiftIsoDate(fromDate,-days),to:shiftIsoDate(toDate,days)};
}
function legOverlapsDateRange(l:Leg, fromDate:string, toDate:string){
  if(!l.startUtc || !l.endUtc) return false;
  const fromMs=new Date(`${fromDate}T00:00:00Z`).getTime();
  const toMs=new Date(`${toDate}T23:59:59Z`).getTime();
  const startMs=new Date(l.startUtc+":00Z").getTime();
  const endMs=new Date(l.endUtc+":00Z").getTime();
  return endMs>=fromMs && startMs<=toMs;
}
function replaceImportedLegsForRange(existing:Leg[], imported:Leg[], fromDate:string, toDate:string){
  const kept=existing.filter(l=>!(l.source==="ICS" && legOverlapsDateRange(l,fromDate,toDate)));
  const seen=new Set(kept.map(legKey));
  const merged=[...kept];
  for(const leg of imported){
    const key=legKey(leg);
    if(!seen.has(key)){ seen.add(key); merged.push(leg); }
  }
  return merged.sort((a,b)=>new Date(a.startUtc+":00Z").getTime()-new Date(b.startUtc+":00Z").getTime());
}

function combineManualWithArchive(existing:Leg[], archive:Leg[]){
  const manual=existing.filter(l=>l.source!=="ICS" && !looksLikePlaceholderLeg(l));
  const seen=new Set<string>();
  const merged:Leg[]=[];
  for(const leg of [...manual,...archive]){
    const key=legKey(leg);
    if(!seen.has(key)){ seen.add(key); merged.push(leg); }
  }
  if(!merged.length) return existing.length ? existing : [];
  return merged.sort((a,b)=>new Date(a.startUtc+":00Z").getTime()-new Date(b.startUtc+":00Z").getTime());
}
function eventFeedCoverage(events:ParsedIcsEvent[]){
  const timed=events.filter(e=>e.startUtc && e.endUtc);
  if(!timed.length) return null;
  const starts=timed.map(e=>e.startUtc.slice(0,10)).sort();
  const ends=timed.map(e=>e.endUtc.slice(0,10)).sort();
  return {from:starts[0],to:ends[ends.length-1]};
}
function rangeIntersection(aFrom:string,aTo:string,bFrom:string,bTo:string){
  const from=aFrom>bFrom?aFrom:bFrom;
  const to=aTo<bTo?aTo:bTo;
  return from<=to?{from,to}:null;
}
function movementTone(type?:MovementType){
  if(type==="FLIGHT") return {row:"border-l-4 border-l-sky-500 bg-sky-50/40",badge:"border-sky-200 bg-sky-100 text-sky-700"};
  if(type==="TRV") return {row:"border-l-4 border-l-amber-500 bg-amber-50/50",badge:"border-amber-200 bg-amber-100 text-amber-700"};
  return {row:"border-l-4 border-l-violet-500 bg-violet-50/50",badge:"border-violet-200 bg-violet-100 text-violet-700"};
}

function guessRatesByLocation(rates: Rate[], country:string, city:string) {
  const exact = rates.find(r=>r.country===country && (r.city||"")===(city||""));
  if (exact) return exact;
  return rates.find(r=>r.country===country && (!r.city || r.city==="Other" || r.city==="")) || null;
}
function toCSV(rows:string[][]){
  return rows.map(r=>r.map(c=>{const s=String(c??""); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}).join(",")).join("\n");
}


function makeId(){
  try { return (globalThis as any).crypto?.randomUUID?.() || Math.random().toString(36).slice(2); }
  catch { return Math.random().toString(36).slice(2); }
}

function unescapeIcsText(value:string){
  return value.replace(/\\n/gi,"\n").replace(/\\,/g,",").replace(/\\;/g,";").replace(/\\\\/g,"\\");
}
function unfoldIcs(text:string){ return text.replace(/\r?\n[ \t]/g,""); }
function readIcsProperty(block:string, name:string){
  const line=block.split(/\r?\n/).find(l=>l.toUpperCase().startsWith(name.toUpperCase()+":") || l.toUpperCase().startsWith(name.toUpperCase()+";"));
  if(!line) return "";
  const idx=line.indexOf(":");
  return idx>=0 ? line.slice(idx+1) : "";
}
function parseIcsUtc(value:string){
  const v=value.trim();
  const m=v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?Z$/);
  if(!m) return "";
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
}
function airportLocationFromBlock(block:string, rates:Rate[], fallbackIcao:string):Location{
  const clean=unescapeIcsText(block).replace(/\s+/g," ").trim();
  const comma=clean.lastIndexOf(",");
  const country=comma>=0 ? clean.slice(comma+1).trim() : "";
  const hay=clean.toLowerCase();
  const cityCandidates=rates
    .filter(r=>r.country===country && !!r.city && r.city!=="Other")
    .map(r=>String(r.city))
    .sort((a,b)=>b.length-a.length);
  const matchedCity=cityCandidates.find(c=>hay.includes(c.toLowerCase())) || "";
  // Keep the country for rate fallback. ICAO stays in the event metadata, while city
  // is only set when it can be matched confidently to the per-diem dataset.
  return {country, city:matchedCity};
}
function parseIcsCalendar(text:string, rates:Rate[]):ParsedIcsEvent[]{
  const unfolded=unfoldIcs(text);
  const blocks=unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  const events:ParsedIcsEvent[]=[];
  for(const block of blocks){
    const summary=unescapeIcsText(readIcsProperty(block,"SUMMARY")).trim();
    const startUtc=parseIcsUtc(readIcsProperty(block,"DTSTART"));
    const endUtc=parseIcsUtc(readIcsProperty(block,"DTEND"));
    const locationText=unescapeIcsText(readIcsProperty(block,"LOCATION"));
    const upper=summary.toUpperCase().trim();
    const route=summary.match(/\b([A-Z]{4})-([A-Z]{4})\b/);
    let kind:ParsedIcsEvent["kind"]="OTHER";
    if(upper==="ON") kind="ON";
    else if(upper==="TRV" || upper.startsWith("TRV ")) kind="TRV";
    else if(route) kind="FLIGHT";

    const ev:ParsedIcsEvent={kind,summary,startUtc,endUtc,locationText};
    if(route){
      ev.fromIcao=route[1]; ev.toIcao=route[2];
      const parts=locationText.split(/\n\s*\n/).map(x=>x.trim()).filter(Boolean);
      if(parts[0]) ev.from=airportLocationFromBlock(parts[0],rates,route[1]);
      if(parts[1]) ev.to=airportLocationFromBlock(parts[1],rates,route[2]);
    }
    events.push(ev);
  }
  return events;
}
function inspectRawIcs(text:string, rates:Rate[], fromDate:string, toDate:string):RawIcsDiagnostics{
  const unfolded=unfoldIcs(text);
  const blocks=unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  const rawDates:string[]=[];
  const rawTimedDates:string[]=[];
  let allDayCount=0;
  let parsedTimedCount=0;
  let unparsedTimedCount=0;
  const selectedRawTimedEvents:Array<{date:string;summary:string;rawStart:string}>=[];

  for(const block of blocks){
    const summary=unescapeIcsText(readIcsProperty(block,"SUMMARY")).trim();
    const rawStart=readIcsProperty(block,"DTSTART").trim();
    const rawEnd=readIcsProperty(block,"DTEND").trim();
    const dm=rawStart.match(/(\d{4})(\d{2})(\d{2})/);
    const date=dm?`${dm[1]}-${dm[2]}-${dm[3]}`:"";
    const isTimed=/T\d{4}/.test(rawStart) || /T\d{4}/.test(rawEnd);

    if(date) rawDates.push(date);

    if(isTimed){
      if(date){
        rawTimedDates.push(date);
        if(date>=fromDate && date<=toDate) selectedRawTimedEvents.push({date,summary,rawStart});
      }
      const parsedStart=parseIcsUtc(rawStart);
      const parsedEnd=parseIcsUtc(rawEnd);
      if(parsedStart && parsedEnd) parsedTimedCount++;
      else unparsedTimedCount++;
    } else {
      allDayCount++;
    }
  }

  rawDates.sort();
  rawTimedDates.sort();

  return {
    eventCount:blocks.length,
    rawFrom:rawDates[0]||"",
    rawTo:rawDates[rawDates.length-1]||"",
    rawTimedFrom:rawTimedDates[0]||"",
    rawTimedTo:rawTimedDates[rawTimedDates.length-1]||"",
    allDayCount,
    parsedTimedCount,
    unparsedTimedCount,
    selectedRawTimedEvents:selectedRawTimedEvents.slice(0,20),
  };
}
function preferredProceedingHome(emp:Employee|null):Location|null{
  if(!emp) return null;
  if(emp.baseSecondary.country && emp.baseSecondary.city) return emp.baseSecondary;
  if(emp.basePrimary.country && emp.basePrimary.city) return emp.basePrimary;
  return null;
}
function buildLegsFromIcs(events:ParsedIcsEvent[], preferredHome:Location|null){
  const warnings:string[]=[];
  const usable=[...events].filter(e=>e.startUtc && e.endUtc).sort((a,b)=>new Date(a.startUtc+":00Z").getTime()-new Date(b.startUtc+":00Z").getTime());
  const flights=usable.filter(e=>e.kind==="FLIGHT");
  const legs:Leg[]=[];

  for(const e of flights){
    if(!e.from || !e.to || !e.from.country || !e.to.country){
      warnings.push(`Flight ${e.summary}: airport countries could not be read from LOCATION.`);
      continue;
    }
    legs.push({id:makeId(),startUtc:e.startUtc,endUtc:e.endUtc,from:{...e.from},to:{...e.to},movementType:"FLIGHT",source:"ICS",label:e.summary});
  }

  for(const e of usable.filter(x=>x.kind==="TRV")){
    const s=new Date(e.startUtc+":00Z").getTime(), en=new Date(e.endUtc+":00Z").getTime();
    const prev=flights.filter(f=>new Date(f.endUtc+":00Z").getTime()<=s && f.to?.country).sort((a,b)=>new Date(b.endUtc+":00Z").getTime()-new Date(a.endUtc+":00Z").getTime())[0];
    const next=flights.filter(f=>new Date(f.startUtc+":00Z").getTime()>=en && f.from?.country).sort((a,b)=>new Date(a.startUtc+":00Z").getTime()-new Date(b.startUtc+":00Z").getTime())[0];
    let from:Location|null=null, to:Location|null=null;
    if(prev && next){ from={...prev.to!}; to={...next.from!}; }
    else if(next && preferredHome){ from={...preferredHome}; to={...next.from!}; }
    else if(prev && preferredHome){ from={...prev.to!}; to={...preferredHome}; }
    if(from && to){
      legs.push({id:makeId(),startUtc:e.startUtc,endUtc:e.endUtc,from,to,movementType:"TRV",source:"ICS",label:e.summary});
    } else {
      warnings.push(`TRV ${e.startUtc}–${e.endUtc}: route could not be inferred. Add it manually.`);
    }
  }

  legs.sort((a,b)=>new Date(a.startUtc+":00Z").getTime()-new Date(b.startUtc+":00Z").getTime());
  return {
    legs,
    warnings,
    stats:{flights:legs.filter(l=>l.movementType==="FLIGHT").length,trv:legs.filter(l=>l.movementType==="TRV").length,on:events.filter(e=>e.kind==="ON").length,other:events.filter(e=>e.kind==="OTHER").length}
  };
}
function isValidFl3xxFeedUrl(value:string){
  try {
    const u=new URL(value);
    return u.protocol==="https:" && u.hostname==="app.fl3xx.com" && /^\/api\/external\/ical\/personSchedules\/\d+\.ics$/.test(u.pathname);
  } catch { return false; }
}

function legKey(l:Leg){ return [l.startUtc,l.endUtc,l.from.country,l.from.city,l.to.country,l.to.city,l.movementType||"MANUAL"].join("|"); }
function looksLikePlaceholderLeg(l:Leg){ return sameLoc(l.from,l.to) && l.startUtc.endsWith("T00:00") && l.endUtc.endsWith("T23:59"); }

function homeBasesFor(emp: Employee | null): Location[] {
  if (!emp) return [];
  const bases=[emp.basePrimary];
  if (emp.baseSecondary.country && emp.baseSecondary.city) bases.push(emp.baseSecondary);
  return bases;
}
function isHome(loc:Location, homes:Location[]) { return homes.some(h=>sameLoc(loc,h)); }

function summarizeTrips(legs:Leg[], homes:Location[]){
  const sorted=[...legs]
    .filter(l=>l.startUtc && l.endUtc)
    .sort((a,b)=>new Date(a.startUtc+":00Z").getTime()-new Date(b.startUtc+":00Z").getTime());
  let active=false;
  let closed=0;
  let open=0;
  let lastClosedAt:Location|null=null;
  for(const leg of sorted){
    const fromHome=isHome(leg.from,homes);
    const toHome=isHome(leg.to,homes);
    if(!active){
      if(fromHome && toHome) continue;
      active=true;
    }
    if(active && toHome){
      closed++;
      lastClosedAt=leg.to;
      active=false;
    }
  }
  if(active) open=1;
  return {closed,open,lastClosedAt};
}

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

    const icsFlight=`BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20260909T100000Z\nDTEND:20260909T120500Z\nLOCATION:LFTH TLN Hyeres Le Palyvestre\\, France\\n\\nLEMG AGP Malaga Costa del Sol\\, Spain\nSUMMARY:Ferry Flight  LFTH-LEMG [D-BEKP]\nEND:VEVENT\nEND:VCALENDAR`;
    const icsTrv=`BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20260909T080000Z\nDTEND:20260909T093000Z\nSUMMARY:TRV\nEND:VEVENT\nEND:VCALENDAR`;
    const icsOn=`BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20260909\nDTEND;VALUE=DATE:20260910\nSUMMARY:ON\nEND:VEVENT\nEND:VCALENDAR`;
    const importedEvents=[...parseIcsCalendar(icsTrv,sampleRates),...parseIcsCalendar(icsFlight,sampleRates),...parseIcsCalendar(icsOn,sampleRates)];
    console.assert(importedEvents.some(e=>e.kind==="FLIGHT" && e.fromIcao==="LFTH" && e.toIcao==="LEMG"),"ICS flight route should parse");
    console.assert(importedEvents.some(e=>e.kind==="ON"),"ICS ON event should be recognized");
    const imported=buildLegsFromIcs(importedEvents,{country:"Poland",city:"Warsaw"});
    console.assert(imported.stats.on===1,"ON should be counted but ignored as a movement");
    console.assert(imported.legs.some(l=>l.movementType==="TRV" && l.from.city==="Warsaw"),"leading TRV should start at preferred home");
    console.assert(isValidFl3xxFeedUrl("https://app.fl3xx.com/api/external/ical/personSchedules/123456.ics"),"FL3XX person schedule URL should be accepted");
    console.assert(!isValidFl3xxFeedUrl("https://example.com/api/external/ical/personSchedules/409479.ics"),"non-FL3XX feed URL should be rejected");
    console.assert(DEFAULT_FL3XX_PROXY_URL.startsWith("https://") && DEFAULT_FL3XX_PROXY_URL.includes("workers.dev"),"default FL3XX proxy URL should be configured");
    console.assert(monthDateBounds("2028-02").to==="2028-02-29","month bounds should cover full leap February");
    console.assert(eventOverlapsDateRange({kind:"FLIGHT",summary:"",startUtc:"2026-08-31T23:00",endUtc:"2026-09-01T01:00",locationText:""},"2026-08-01","2026-08-31"),"date range should include overlapping events");
    const ctx=expandedContextRange("2026-08-01","2026-08-31",7);
    console.assert(ctx.from==="2026-07-25" && ctx.to==="2026-09-07","sync context should extend seven days around selected range");
    const manualKeep:Leg={id:"m",startUtc:"2026-09-10T08:00",endUtc:"2026-09-10T09:00",from:homes[1],to:{country:"France",city:"Paris"},movementType:"MANUAL",source:"MANUAL"};
    const oldIcs:Leg={id:"old",startUtc:"2026-09-10T10:00",endUtc:"2026-09-10T11:00",from:{country:"France",city:"Paris"},to:{country:"Italy",city:"Olbia"},movementType:"FLIGHT",source:"ICS"};
    const outsideIcs:Leg={id:"outside",startUtc:"2026-10-02T10:00",endUtc:"2026-10-02T11:00",from:homes[1],to:{country:"France",city:"Paris"},movementType:"FLIGHT",source:"ICS"};
    const freshIcs:Leg={id:"fresh",startUtc:"2026-09-10T12:00",endUtc:"2026-09-10T13:00",from:{country:"Italy",city:"Olbia"},to:homes[1],movementType:"FLIGHT",source:"ICS"};
    const replaced=replaceImportedLegsForRange([manualKeep,oldIcs,outsideIcs],[freshIcs],"2026-09-01","2026-09-30");
    console.assert(replaced.some(l=>l.id==="m"),"refresh should preserve manual legs");
    console.assert(!replaced.some(l=>l.id==="old") && replaced.some(l=>l.id==="fresh"),"refresh should replace ICS legs inside selected range");
    console.assert(replaced.some(l=>l.id==="outside"),"refresh should preserve ICS legs outside selected range");
    const tripStats=summarizeTrips([manualKeep,freshIcs],homes);
    console.assert(tripStats.closed===1 && tripStats.open===0,"trip summary should recognize a closed trip");
  } catch {}
})();

export default function App(){
  const [rates,setRates]=useState<Rate[]>(emptyRates);
  const [ratesStatus,setRatesStatus]=useState<"idle"|"loading"|"loaded"|"error">("idle");
  const [ratesYear,setRatesYear]=useState<number|null>(2025);
  const ccMap=useMemo(()=>buildCountryCityMap(rates),[rates]);
  const allCountries=useMemo(()=>countryListFromMap(ccMap),[ccMap]);
  const cityList=(c:string)=>citiesFor(ccMap,c);

  const [employees,setEmployees]=useState<Employee[]>(defaultEmployees);
  const [selectedEmpId,setSelectedEmpId]=useState(defaultEmployees[0].id);
  const selectedEmp=employees.find(e=>e.id===selectedEmpId)||null;
  const [empPanelOpen,setEmpPanelOpen]=useState(false);
  const [empForm,setEmpForm]=useState<Employee>({id:"",name:"",basePrimary:{country:"Germany",city:"Berlin"},baseSecondary:{country:"Poland",city:"Warsaw"}});
  const [month,setMonth]=useState(()=>defaultReportMonth());
  const selectedYear=Number(month.slice(0,4));
  const initialImportRange=monthDateBounds(month);
  const [fl3xxFromDate,setFl3xxFromDate]=useState(initialImportRange.from);
  const [fl3xxToDate,setFl3xxToDate]=useState(initialImportRange.to);

  const makeDefaultLeg=():Leg=>{
    const id=makeId();
    const d=new Date(); const ds=isoDate(d);
    const base=selectedEmp?.basePrimary||{country:"Germany",city:"Berlin"};
    return {id,startUtc:`${ds}T00:00`,endUtc:`${ds}T23:59`,from:{...base},to:{...base},movementType:"MANUAL",source:"MANUAL"};
  };
  const [legs,setLegs]=useState<Leg[]>([makeDefaultLeg()]);
  const [breakfastByDate,setBreakfastByDate]=useState<Record<string,boolean>>({});
  const [icsImportStatus,setIcsImportStatus]=useState("");
  const [fl3xxProxyUrl,setFl3xxProxyUrl]=useState(DEFAULT_FL3XX_PROXY_URL);
  const [fl3xxFeedUrl,setFl3xxFeedUrl]=useState("");
  const [fl3xxUser,setFl3xxUser]=useState("");
  const [fl3xxPassword,setFl3xxPassword]=useState("");
  const [fl3xxSyncing,setFl3xxSyncing]=useState(false);
  const [fl3xxPanelOpen,setFl3xxPanelOpen]=useState(false);
  const [lastSyncAt,setLastSyncAt]=useState<string>("");
  const [fl3xxArchive,setFl3xxArchive]=useState<Leg[]>([]);
  const [hiddenIcsKeys,setHiddenIcsKeys]=useState<string[]>([]);
  const [lastHiddenKey,setLastHiddenKey]=useState<string>("");
  const [feedCoverage,setFeedCoverage]=useState<{from:string;to:string}|null>(null);
  const [rawFeedText,setRawFeedText]=useState("");
  const [rawDiag,setRawDiag]=useState<RawIcsDiagnostics|null>(null);
  const previewRef=useRef<HTMLDivElement>(null);

  useEffect(()=>{
    const bounds=monthDateBounds(month);
    setFl3xxFromDate(bounds.from);
    setFl3xxToDate(bounds.to);
  },[month]);

  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      setRatesStatus("loading");

      // Use a cached table only when it belongs to the currently selected year.
      try{
        const cachedYear=Number(localStorage.getItem(LS_RATES_YEAR_KEY)||"");
        const raw=localStorage.getItem(LS_RATES_KEY);
        if(raw && cachedYear===selectedYear){
          const arr=JSON.parse(raw);
          if(Array.isArray(arr)&&arr.length){
            if(!cancelled){setRates(arr);setRatesYear(cachedYear);setRatesStatus("loaded");}
            return;
          }
        }
      }catch{}

      // Automatically load public/per_diem_YYYY.json for the selected report year.
      for(const url of rateCandidatesForYear(selectedYear)){
        try{
          const res=await fetch(url,{cache:"no-store"});
          if(!res.ok) continue;
          const payload=await res.json();
          const cleaned=normalizeRates(payload);
          if(cleaned.length && !cancelled){
            const fileYear=Number(payload?.year)||selectedYear;
            setRates(cleaned);
            setRatesYear(fileYear);
            setRatesStatus("loaded");
            try{
              localStorage.setItem(LS_RATES_KEY,JSON.stringify(cleaned));
              localStorage.setItem(LS_RATES_YEAR_KEY,String(fileYear));
            }catch{}
            return;
          }
        }catch{}
      }

      if(!cancelled){
        setRates([]);
        setRatesYear(null);
        setRatesStatus("error");
      }
    })();
    return()=>{cancelled=true};
  },[selectedYear]);

  useEffect(()=>{try{const raw=localStorage.getItem(LS_EMPLOYEES_KEY);if(raw){const arr=JSON.parse(raw);if(Array.isArray(arr)&&arr.length){setEmployees(arr);if(!arr.some((e:Employee)=>e.id===selectedEmpId))setSelectedEmpId(arr[0].id);}}}catch{}},[]);
  useEffect(()=>{try{localStorage.setItem(LS_EMPLOYEES_KEY,JSON.stringify(employees));}catch{}},[employees]);
  useEffect(()=>{
    try{
      let tripLegs:Leg[]=[];
      const raw=localStorage.getItem(LS_TRIPS_KEY);
      if(raw){
        const p=JSON.parse(raw);
        if(Array.isArray(p.legs)) tripLegs=p.legs;
        if(p.breakfastByDate&&typeof p.breakfastByDate==="object") setBreakfastByDate(p.breakfastByDate);
      }

      let archive:Leg[]=[];
      const archiveRaw=localStorage.getItem(LS_FL3XX_ARCHIVE_KEY);
      if(archiveRaw){
        const parsed=JSON.parse(archiveRaw);
        if(Array.isArray(parsed)) archive=parsed.filter((l:any)=>l&&l.source==="ICS");
      }

      const hiddenRaw=localStorage.getItem(LS_FL3XX_HIDDEN_KEY);
      if(hiddenRaw){
        const parsed=JSON.parse(hiddenRaw);
        if(Array.isArray(parsed)) setHiddenIcsKeys(parsed.filter((x:any)=>typeof x==="string"));
      }

      // Recovery/migration: ALWAYS merge any older FL3XX/ICS movements still present
      // in per_diem_trips_v2 into the archive. This protects historical legs that
      // were imported before the dedicated archive existed.
      const legacyIcs=tripLegs.filter(l=>l.source==="ICS");
      if(legacyIcs.length){
        const seen=new Set<string>();
        archive=[...archive,...legacyIcs]
          .filter(l=>{const k=legKey(l);if(seen.has(k))return false;seen.add(k);return true;})
          .sort((a,b)=>new Date(a.startUtc+":00Z").getTime()-new Date(b.startUtc+":00Z").getTime());
        localStorage.setItem(LS_FL3XX_ARCHIVE_KEY,JSON.stringify(archive));
      }

      setFl3xxArchive(archive);
      if(tripLegs.length){
        const combined=combineManualWithArchive(tripLegs,archive);
        setLegs(combined.length?combined:tripLegs);
      } else if(archive.length) {
        setLegs(archive);
      }
    }catch{}
  },[]);
  useEffect(()=>{try{localStorage.setItem(LS_TRIPS_KEY,JSON.stringify({legs,breakfastByDate}));}catch{}},[legs,breakfastByDate]);
  useEffect(()=>{
    try {
      const raw=localStorage.getItem(LS_FL3XX_SETTINGS_KEY);
      if(raw){
        const v=JSON.parse(raw);
        if(typeof v?.proxyUrl==="string" && v.proxyUrl.trim()) setFl3xxProxyUrl(v.proxyUrl);
        if(typeof v?.feedUrl==="string") setFl3xxFeedUrl(v.feedUrl);
        if(typeof v?.user==="string") setFl3xxUser(v.user);
      }
    } catch {}
  },[]);
  useEffect(()=>{
    try { localStorage.setItem(LS_FL3XX_SETTINGS_KEY, JSON.stringify({proxyUrl:fl3xxProxyUrl,feedUrl:fl3xxFeedUrl,user:fl3xxUser})); } catch {}
  },[fl3xxProxyUrl,fl3xxFeedUrl,fl3xxUser]);

  function onUploadRatesFile(file:File){const r=new FileReader();r.onload=()=>{try{const text=String(r.result||"");const parsed=/^\s*[\[{]/.test(text)?normalizeRates(JSON.parse(text)):parseCSV(text);const m=file.name.match(/(20\d{2})/);const yr=m?Number(m[1]):null;setRates(parsed);setRatesYear(yr);setRatesStatus("loaded");try{localStorage.setItem(LS_RATES_KEY,JSON.stringify(parsed));if(yr)localStorage.setItem(LS_RATES_YEAR_KEY,String(yr));else localStorage.removeItem(LS_RATES_YEAR_KEY);}catch{}}catch{alert("Failed to parse rates file");}};r.readAsText(file);}
  function addOrUpdateEmployee(){const id=empForm.id.toUpperCase();if(!/^[A-Z]{3}$/.test(id)){alert("Employee ID must be exactly 3 letters");return;}const entry={...empForm,id,name:empForm.name.trim()||id};setEmployees(prev=>{const n=prev.some(e=>e.id===id)?prev.map(e=>e.id===id?entry:e):[...prev,entry];return n.sort((a,b)=>a.id.localeCompare(b.id));});setSelectedEmpId(id);setEmpPanelOpen(false);}
  function exportEmployeesJSON(){const blob=new Blob([JSON.stringify(employees,null,2)],{type:"application/json"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download="employees.json";a.click();URL.revokeObjectURL(url);}
  function onImportEmployeesFile(file:File){const r=new FileReader();r.onload=()=>{try{const arr=JSON.parse(String(r.result||""));if(!Array.isArray(arr))throw 0;const cleaned:Employee[]=arr.filter((e:any)=>/^[A-Z]{3}$/.test(String(e?.id||"").toUpperCase())).map((e:any)=>({id:String(e.id).toUpperCase(),name:String(e.name||e.id),basePrimary:{country:String(e?.basePrimary?.country||""),city:String(e?.basePrimary?.city||"")},baseSecondary:{country:String(e?.baseSecondary?.country||""),city:String(e?.baseSecondary?.city||"")}}));if(!cleaned.length)throw 0;setEmployees(cleaned);setSelectedEmpId(cleaned[0].id);}catch{alert("Invalid employees JSON");}};r.readAsText(file);}

  function mergeImportedLegs(importedLegs:Leg[]){
    setLegs(prev=>{
      const base=(prev.length===1 && looksLikePlaceholderLeg(prev[0])) ? [] : prev;
      const seen=new Set(base.map(legKey));
      const merged=[...base];
      for(const leg of importedLegs){
        const key=legKey(leg);
        if(!seen.has(key)){ seen.add(key); merged.push(leg); }
      }
      return merged.sort((a,b)=>new Date(a.startUtc+":00Z").getTime()-new Date(b.startUtc+":00Z").getTime());
    });
  }

  function saveHiddenIcsKeys(keys:string[]){
    setHiddenIcsKeys(keys);
    try{localStorage.setItem(LS_FL3XX_HIDDEN_KEY,JSON.stringify(keys));}catch{}
  }
  function hideIcsMovement(leg:Leg){
    const key=legKey(leg);
    if(hiddenIcsKeys.includes(key)) return;
    const next=[...hiddenIcsKeys,key];
    saveHiddenIcsKeys(next);
    setLastHiddenKey(key);
  }
  function undoLastHide(){
    if(!lastHiddenKey) return;
    const next=hiddenIcsKeys.filter(k=>k!==lastHiddenKey);
    saveHiddenIcsKeys(next);
    setLastHiddenKey("");
  }
  function restoreAllHidden(){
    saveHiddenIcsKeys([]);
    setLastHiddenKey("");
  }

  function recoverLegacyTrips(){
    try{
      const raw=localStorage.getItem(LS_TRIPS_KEY);
      if(!raw){ alert("No legacy trip cache found in this browser."); return; }
      const parsed=JSON.parse(raw);
      const legacy:Array<Leg>=Array.isArray(parsed?.legs)?parsed.legs.filter((l:any)=>l&&l.source==="ICS"):[];
      if(!legacy.length){ alert("No older FL3XX movements found in the legacy trip cache."); return; }

      const seen=new Set<string>();
      const merged=[...fl3xxArchive,...legacy]
        .filter(l=>{const k=legKey(l);if(seen.has(k))return false;seen.add(k);return true;})
        .sort((a,b)=>new Date(a.startUtc+":00Z").getTime()-new Date(b.startUtc+":00Z").getTime());

      const added=Math.max(0,merged.length-fl3xxArchive.length);
      saveFl3xxArchive(merged);
      setLegs(prev=>combineManualWithArchive(prev,merged));
      setIcsImportStatus(`Legacy recovery checked ${legacy.length} FL3XX movement(s); ${added} movement(s) restored to the archive.`);
      if(added===0) alert("Legacy cache checked, but it contained no additional FL3XX movements.");
    }catch{
      alert("Could not read the legacy trip cache.");
    }
  }

  function saveFl3xxArchive(archive:Leg[]){
    setFl3xxArchive(archive);
    try{localStorage.setItem(LS_FL3XX_ARCHIVE_KEY,JSON.stringify(archive));}catch{}
  }
  function exportFl3xxArchive(){
    const payload={version:1,exportedAt:new Date().toISOString(),movements:fl3xxArchive};
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;
    a.download=`fl3xx_archive_${selectedEmp?.id||"EMP"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  function onImportFl3xxArchive(file:File){
    const r=new FileReader();
    r.onload=()=>{
      try{
        const parsed=JSON.parse(String(r.result||""));
        const arr=Array.isArray(parsed)?parsed:parsed?.movements;
        if(!Array.isArray(arr)) throw new Error("Invalid archive");
        const cleaned:Leg[]=arr.filter((l:any)=>l&&l.startUtc&&l.endUtc&&l.from&&l.to).map((l:any)=>({...l,source:"ICS"}));
        const seen=new Set<string>();
        const merged=[...fl3xxArchive,...cleaned].filter(l=>{const k=legKey(l);if(seen.has(k))return false;seen.add(k);return true;})
          .sort((a,b)=>new Date(a.startUtc+":00Z").getTime()-new Date(b.startUtc+":00Z").getTime());
        saveFl3xxArchive(merged);
        setLegs(prev=>combineManualWithArchive(prev,merged));
        setIcsImportStatus(`Archive restored: ${cleaned.length} movement(s) read, ${merged.length} stored in total.`);
      }catch{
        alert("Invalid FL3XX archive file.");
      }
    };
    r.readAsText(file);
  }

  function downloadRawFl3xxFeed(){
    if(!rawFeedText){ alert("Refresh FL3XX first so the raw feed is available."); return; }
    const blob=new Blob([rawFeedText],{type:"text/calendar;charset=utf-8"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;
    a.download=`fl3xx_raw_${fl3xxFromDate}_${fl3xxToDate}.ics`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function syncFl3xxCalendar(){
    const proxy=fl3xxProxyUrl.trim();
    const feed=fl3xxFeedUrl.trim();
    const user=fl3xxUser.trim();
    if(!proxy){ alert("Enter the FL3XX proxy URL first."); setFl3xxPanelOpen(true); return; }
    if(!isValidFl3xxFeedUrl(feed)){ alert("Enter a valid FL3XX personSchedules .ics URL."); setFl3xxPanelOpen(true); return; }
    if(!user || !fl3xxPassword){ alert("Enter your FL3XX User ID and Password."); setFl3xxPanelOpen(true); return; }
    setFl3xxSyncing(true);
    setIcsImportStatus("Syncing FL3XX calendar…");
    try {
      const res=await fetch(proxy,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({feedUrl:feed,username:user,password:fl3xxPassword}),
      });
      const body=await res.text();
      if(!res.ok){
        let message=`FL3XX sync failed (${res.status}).`;
        try { const j=JSON.parse(body); if(j?.error) message += ` ${j.error}`; } catch {}
        throw new Error(message);
      }
      setRawFeedText(body);
      const diagnostics=inspectRawIcs(body,rates,fl3xxFromDate,fl3xxToDate);
      setRawDiag(diagnostics);

      const allEvents=parseIcsCalendar(body,rates);
      const coverage=eventFeedCoverage(allEvents);
      setFeedCoverage(coverage);

      // Keep a seven-day context on both sides of the requested range.
      // This lets TRV/flight chains crossing a month boundary remain connected.
      const context=expandedContextRange(fl3xxFromDate,fl3xxToDate,7);
      const contextEvents=allEvents.filter(e=>eventOverlapsDateRange(e,context.from,context.to));
      const result=buildLegsFromIcs(contextEvents,preferredProceedingHome(selectedEmp));

      // Refresh only the part of the archive that the current FL3XX feed actually covers.
      // Historical movements outside current feed coverage are NEVER deleted.
      let nextArchive=fl3xxArchive;
      const refreshWindow=coverage?rangeIntersection(context.from,context.to,coverage.from,coverage.to):null;
      if(refreshWindow){
        nextArchive=replaceImportedLegsForRange(fl3xxArchive,result.legs,refreshWindow.from,refreshWindow.to)
          .filter(l=>l.source==="ICS");
        saveFl3xxArchive(nextArchive);
        setLegs(prev=>combineManualWithArchive(prev,nextArchive));
      }

      const reportArchiveLegs=nextArchive.filter(l=>legOverlapsDateRange(l,fl3xxFromDate,fl3xxToDate));
      const reportFlights=reportArchiveLegs.filter(l=>l.movementType==="FLIGHT").length;
      const reportTrv=reportArchiveLegs.filter(l=>l.movementType==="TRV").length;

      let details=`Archive: ${nextArchive.length} movement(s). Report range contains ${reportFlights} flight(s), ${reportTrv} TRV proceeding(s).`;
      if(coverage) details+=` FL3XX feed available: ${coverage.from} → ${coverage.to}.`;
      if(coverage && fl3xxFromDate<coverage.from) details+=` Earlier dates are outside the current FL3XX feed and can only come from your local archive or manual ICS import.`;
      const warningText=result.warnings.length ? ` ${result.warnings.join(" ")}` : "";
      setIcsImportStatus(details+warningText);
      setLastSyncAt(new Date().toLocaleString());

      // After a successful FL3XX sync, guide the user directly to the result.
      // Two animation frames give React time to render the imported movements first.
      requestAnimationFrame(()=>{
        requestAnimationFrame(()=>{
          previewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      });
    } catch(err:any) {
      console.error(err);
      const msg=err?.message || "FL3XX sync failed.";
      setIcsImportStatus(msg);
      alert(msg);
    } finally {
      setFl3xxSyncing(false);
    }
  }

  async function onImportIcsFiles(fileList:FileList|null){
    if(!fileList?.length) return;
    try{
      const texts=await Promise.all(Array.from(fileList).map(f=>f.text()));
      const events=texts.flatMap(text=>parseIcsCalendar(text,rates));
      const result=buildLegsFromIcs(events,preferredProceedingHome(selectedEmp));
      if(!result.legs.length){
        const msg=result.stats.on>0 && result.stats.flights===0 && result.stats.trv===0
          ? `No travel movements found. ${result.stats.on} ON event(s) were correctly ignored.`
          : "No importable FL3XX Flight/TRV movements found.";
        setIcsImportStatus(msg);
        alert(msg);
        return;
      }
      const seen=new Set<string>();
      const mergedArchive=[...fl3xxArchive,...result.legs].filter(l=>{const k=legKey(l);if(seen.has(k))return false;seen.add(k);return true;})
        .sort((a,b)=>new Date(a.startUtc+":00Z").getTime()-new Date(b.startUtc+":00Z").getTime());
      saveFl3xxArchive(mergedArchive);
      setLegs(prev=>combineManualWithArchive(prev,mergedArchive));
      const details=`Imported ${result.stats.flights} flight(s), ${result.stats.trv} TRV proceeding(s) into local archive. Ignored ${result.stats.on} ON event(s).`;
      const warningText=result.warnings.length ? ` ${result.warnings.join(" ")}` : "";
      setIcsImportStatus(details+warningText);
    }catch(err){
      console.error(err);
      setIcsImportStatus("ICS import failed.");
      alert("ICS import failed. Please use FL3XX/Apple .ics files.");
    }
  }

  function addLeg(){setLegs(l=>[...l,{...makeDefaultLeg(),movementType:"MANUAL",source:"MANUAL"}]);}
  function addNextLeg(){setLegs(l=>{const last=l[l.length-1];if(!last)return[makeDefaultLeg()];const id=makeId();const start=last.endUtc;const d=new Date(start+":00Z");const endUtc=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),23,59)).toISOString().slice(0,16);return[...l,{id,startUtc:start,endUtc,from:{...last.to},to:{...last.from},movementType:"MANUAL",source:"MANUAL"}];});}
  function removeLeg(id:string){
    const target=legs.find(x=>x.id===id);
    if(!target) return;
    if(target.source==="ICS"){
      hideIcsMovement(target);
      return;
    }
    setLegs(prev=>prev.filter(x=>x.id!==id));
  }

  const homes=homeBasesFor(selectedEmp);

  const visibleLegs=useMemo(()=>legs.filter(l=>l.source!=="ICS" || !hiddenIcsKeys.includes(legKey(l))),[legs,hiddenIcsKeys]);
  const reportLegs=useMemo(
    ()=>visibleLegs.filter(l=>legOverlapsDateRange(l,fl3xxFromDate,fl3xxToDate)),
    [visibleLegs,fl3xxFromDate,fl3xxToDate]
  );

  const calcContextFrom=shiftIsoDate(fl3xxFromDate,-7);
  const calcLegs=useMemo(
    ()=>visibleLegs.filter(l=>l.endUtc.slice(0,10)>=calcContextFrom && l.startUtc.slice(0,10)<=fl3xxToDate),
    [visibleLegs,calcContextFrom,fl3xxToDate]
  );
  const calcAll=useMemo(()=>buildDailyPerDiems(calcLegs,rates,homes,breakfastByDate),[calcLegs,rates,selectedEmp,breakfastByDate]);
  const calc=useMemo(()=>({
    items:calcAll.items.filter(it=>it.date>=fl3xxFromDate && it.date<=fl3xxToDate),
    warnings:calcAll.warnings.filter(w=>!w.startsWith("Open trip:")),
  }),[calcAll,fl3xxFromDate,fl3xxToDate]);
  const totalEUR=calc.items.reduce((s,it)=>s+it.perDiemEUR,0);
  const tripSummary=useMemo(()=>summarizeTrips(calcLegs,homes),[calcLegs,selectedEmp]);
  const ratesYearMismatch=!!ratesYear && Number.isFinite(selectedYear) && selectedYear!==ratesYear;
  const monthLegs=reportLegs;
  const monthFlights=monthLegs.filter(l=>l.movementType==="FLIGHT").length;
  const monthTrv=monthLegs.filter(l=>l.movementType==="TRV").length;
  const monthManual=monthLegs.filter(l=>l.movementType==="MANUAL").length;
  const allBreakfastChecked=calc.items.length>0 && calc.items.every(it=>!!breakfastByDate[it.date]);
  function setBreakfastForAll(checked:boolean){
    setBreakfastByDate(prev=>{
      const next={...prev};
      for(const it of calc.items) next[it.date]=checked;
      return next;
    });
  }

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

  return <div className="min-h-screen bg-gradient-to-b from-slate-100 via-slate-50 to-white text-slate-900">
  <div className="mx-auto max-w-6xl p-4 md:p-6 space-y-4">
    <div className="rounded-3xl bg-gradient-to-r from-slate-950 via-slate-900 to-sky-950 p-4 md:p-5 shadow-lg shadow-slate-300/40">
    <div className="flex items-center gap-4">
      <div className="rounded-2xl bg-white/95 p-2 shadow-sm"><img src={DEFAULT_LOGO_URL} alt="Logo" className="h-10 w-auto"/></div>
      <Card className="flex-1 border-white/10 bg-white/95"><CardContent>
        <div className="flex items-end gap-3 flex-wrap">
          <div><label className="mb-1 block text-sm font-medium">Employee</label><select className="w-[220px] rounded-xl border px-3 py-2 text-sm" value={selectedEmpId} onChange={e=>setSelectedEmpId(e.target.value)}>{employees.map(e=><option key={e.id} value={e.id}>{e.id} — {e.name}</option>)}</select></div>
          <Button variant="outline" className="gap-2" onClick={()=>setEmpPanelOpen(v=>!v)}><IconEdit className="h-4 w-4"/> Add / Edit employee</Button>
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
    </div>

    <div className="flex items-center gap-3 flex-wrap">
      <Card className="p-3 flex items-center gap-3">
        <Badge className={ratesStatus==="error"||ratesYearMismatch?"border-amber-300 bg-amber-50 text-amber-800":"border-emerald-200 bg-emerald-50 text-emerald-700"}>
          {ratesStatus==="loaded" ? `Rates ${ratesYear} · automatic` : ratesStatus==="loading" ? `Loading ${selectedYear} rates…` : `Rates ${selectedYear} missing`}
        </Badge>
        <label className="text-xs cursor-pointer text-slate-500 hover:text-slate-700"><input type="file" accept=".json,.csv" className="hidden" onChange={e=>{const f=e.target.files?.[0];if(f)onUploadRatesFile(f);}}/><span className="inline-flex items-center gap-1"><IconUpload className="h-3.5 w-3.5"/> Manual override</span></label>
      </Card>
      <Card className="p-3 flex items-center gap-2">
        <Button variant="outline" onClick={()=>setFl3xxPanelOpen(v=>!v)}>FL3XX settings</Button>
        <div className="hidden xl:flex items-center gap-2 text-xs text-slate-500"><span>{fl3xxFromDate}</span><span>→</span><span>{fl3xxToDate}</span></div>
        <Button onClick={()=>void syncFl3xxCalendar()} disabled={fl3xxSyncing}>{fl3xxSyncing?"Refreshing…":"Refresh FL3XX"}</Button>
      </Card>
      <Card className="p-3 flex items-center gap-3"><label className="text-sm cursor-pointer"><input type="file" accept=".ics,text/calendar" multiple className="hidden" onChange={e=>{void onImportIcsFiles(e.target.files);e.currentTarget.value="";}}/><span className="inline-flex items-center gap-2 text-slate-600"><IconUpload className="h-4 w-4"/> Manual ICS import</span></label></Card>
      <div className="grow"/><Button variant="outline" onClick={exportCSV}>Export CSV</Button>
    </div>
    {(ratesStatus==="error"||ratesYearMismatch) && <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      {ratesStatus==="error"
        ? <><strong>Rates {selectedYear} not found.</strong> Add <code>per_diem_{selectedYear}.json</code> to the app's <code>public</code> folder.</>
        : <><strong>Rates year mismatch:</strong> selected month is {selectedYear}, but loaded rates are {ratesYear}.</>}
    </div>}
    {icsImportStatus && <div className="rounded-xl border border-sky-100 bg-sky-50 px-3 py-2 text-xs text-sky-800">
      {icsImportStatus}{lastSyncAt?<span className="ml-2 text-sky-600">Last refresh: {lastSyncAt}</span>:null}
    </div>}
    {(feedCoverage||fl3xxArchive.length>0) && <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 px-1">
      {feedCoverage&&<span>Current FL3XX feed coverage: <strong>{feedCoverage.from} → {feedCoverage.to}</strong></span>}
      <span>Local archive: <strong>{fl3xxArchive.length}</strong> movement(s)</span>
      {hiddenIcsKeys.length>0&&<span>Hidden from report: <strong>{hiddenIcsKeys.length}</strong></span>}
      {lastHiddenKey&&<button type="button" className="font-medium text-sky-700 hover:underline" onClick={undoLastHide}>Undo last hide</button>}
      {feedCoverage&&fl3xxFromDate<feedCoverage.from&&<span className="text-amber-700">Selected range starts before FL3XX feed history.</span>}
    </div>}
    {rawDiag&&<div className={`rounded-xl border px-3 py-2 text-xs ${rawDiag.unparsedTimedCount>0 || (rawDiag.rawTimedFrom && feedCoverage?.from && rawDiag.rawTimedFrom<feedCoverage.from) ? "border-amber-200 bg-amber-50 text-amber-900" : "border-slate-200 bg-white text-slate-600"}`}>
      <strong>Raw FL3XX diagnostics:</strong> {rawDiag.eventCount} VEVENT(s)
      {" · "}all events {rawDiag.rawFrom||"?"} → {rawDiag.rawTo||"?"}
      {" · "}timed movements {rawDiag.rawTimedFrom||"none"} → {rawDiag.rawTimedTo||"none"}
      {" · "}all-day {rawDiag.allDayCount}
      {" · "}parsed timed {rawDiag.parsedTimedCount}
      {" · "}unparsed timed {rawDiag.unparsedTimedCount}.
      {rawDiag.rawTimedFrom && feedCoverage?.from && rawDiag.rawTimedFrom<feedCoverage.from
        ? <span className="ml-1 font-medium">A timed event exists earlier than the parsed movement coverage — parser issue suspected.</span>
        : null}
      {rawDiag.unparsedTimedCount>0
        ? <span className="ml-1 font-medium">{rawDiag.unparsedTimedCount} timed event(s) could not be parsed.</span>
        : null}
      {rawDiag.selectedRawTimedEvents.length>0&&<span className="ml-1">Timed events inside selected range: {rawDiag.selectedRawTimedEvents.length} (first 20 inspected).</span>}
    </div>}

    {fl3xxPanelOpen && <Card><CardHeader><CardTitle>FL3XX Calendar Connection</CardTitle></CardHeader><CardContent>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="md:col-span-2">
          <details className="rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium text-slate-700">Advanced settings</summary>
            <div className="mt-3">
              <label className="mb-1 block text-sm font-medium">Proxy URL</label>
              <Input placeholder="https://your-worker.workers.dev/" value={fl3xxProxyUrl} onChange={e=>setFl3xxProxyUrl(e.target.value)}/>
              <div className="mt-1 text-xs text-neutral-500">Normally you do not need to change this. The company proxy is preconfigured.</div>
              <div className="mt-4 border-t border-slate-200 pt-3">
                <div className="text-sm font-medium">FL3XX local archive</div>
                <div className="mt-1 text-xs text-slate-500">Stored only in this browser. FL3XX movements are never deleted from the archive by the movement list; “Hide from report” only excludes them from calculations. Backup is useful before changing computer or clearing browser data.</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button type="button" variant="secondary" onClick={exportFl3xxArchive} disabled={!fl3xxArchive.length}>Backup archive</Button>
                  <Button type="button" variant="secondary" onClick={downloadRawFl3xxFeed} disabled={!rawFeedText}>Download raw FL3XX feed</Button>
                  <Button type="button" variant="secondary" onClick={recoverLegacyTrips}>Recover legacy trips</Button>
                  <Button type="button" variant="secondary" onClick={restoreAllHidden} disabled={!hiddenIcsKeys.length}>Restore hidden ({hiddenIcsKeys.length})</Button>
                  <label className="inline-flex cursor-pointer items-center rounded-xl bg-slate-100 px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-200">
                    <input type="file" accept="application/json,.json" className="hidden" onChange={e=>{const f=e.target.files?.[0];if(f)onImportFl3xxArchive(f);e.currentTarget.value="";}}/>
                    Restore archive
                  </label>
                </div>
              </div>
            </div>
          </details>
        </div>
        <div className="md:col-span-2"><label className="mb-1 block text-sm font-medium">FL3XX calendar URL</label><Input placeholder="https://app.fl3xx.com/api/external/ical/personSchedules/123456.ics" value={fl3xxFeedUrl} onChange={e=>setFl3xxFeedUrl(e.target.value)}/></div>
        <div><label className="mb-1 block text-sm font-medium">FL3XX User ID</label><Input autoComplete="username" value={fl3xxUser} onChange={e=>setFl3xxUser(e.target.value)}/></div>
        <div><label className="mb-1 block text-sm font-medium">FL3XX Password</label><Input type="password" autoComplete="current-password" value={fl3xxPassword} onChange={e=>setFl3xxPassword(e.target.value)}/><div className="mt-1 text-xs text-neutral-500">Password is kept only in this browser tab's memory and is not saved to localStorage.</div></div>
        <div><label className="mb-1 block text-sm font-medium">Import from</label><Input type="date" value={fl3xxFromDate} onChange={e=>setFl3xxFromDate(e.target.value)}/></div>
        <div><label className="mb-1 block text-sm font-medium">Import to</label><Input type="date" value={fl3xxToDate} onChange={e=>setFl3xxToDate(e.target.value)}/><div className="mt-1 text-xs text-slate-500">Defaults to the selected month. You can narrow it to any duty period.</div></div>
      </div>
      <div className="mt-3 flex gap-2"><Button onClick={()=>void syncFl3xxCalendar()} disabled={fl3xxSyncing}>{fl3xxSyncing?"Refreshing…":"Refresh now"}</Button><Button variant="secondary" onClick={()=>setFl3xxPanelOpen(false)}>Close</Button></div>
    </CardContent></Card>}

    <Card className="overflow-hidden">
      <CardContent className="py-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold">{month}</span>
          <Badge className="border-sky-200 bg-sky-50 text-sky-700">{monthFlights} Flight{monthFlights===1?"":"s"}</Badge>
          <Badge className="border-amber-200 bg-amber-50 text-amber-700">{monthTrv} TRV</Badge>
          {monthManual>0&&<Badge className="border-violet-200 bg-violet-50 text-violet-700">{monthManual} Manual</Badge>}
          <Badge>{calc.items.length} per-diem day{calc.items.length===1?"":"s"}</Badge>
          <span className="ml-auto font-semibold">€ {totalEUR.toFixed(2)}</span>
          {tripSummary.open>0
            ? <Badge className="border-amber-300 bg-amber-100 text-amber-800">Open trip — return to home base missing</Badge>
            : tripSummary.closed>0
              ? <Badge className="border-emerald-300 bg-emerald-100 text-emerald-800">Trips closed{tripSummary.lastClosedAt?` · ${locLabel(tripSummary.lastClosedAt)}`:""}</Badge>
              : <Badge className="text-slate-500">No per-diem trip detected</Badge>}
        </div>
      </CardContent>
    </Card>

    <Card><CardHeader className="flex items-center justify-between"><CardTitle>Trip Legs (UTC)</CardTitle><div className="flex gap-2"><Button variant="secondary" className="gap-2" onClick={addLeg}><IconPlus className="h-4 w-4"/> Add new leg</Button><Button variant="secondary" className="gap-2" onClick={addNextLeg}><IconPlus className="h-4 w-4"/> Next leg</Button></div></CardHeader>
      <CardContent className="space-y-3">{reportLegs.map(leg=>{const invalid=new Date(leg.startUtc+":00Z")>=new Date(leg.endUtc+":00Z");const tone=movementTone(leg.movementType);return <div key={leg.id} className={`grid grid-cols-1 lg:grid-cols-12 gap-2 items-end rounded-2xl border border-slate-200 p-3 ${tone.row}`}> 
        <div className="lg:col-span-2"><label className="text-xs block">Start UTC</label><input type="datetime-local" step={300} className={`w-full rounded-xl border px-3 py-2 text-sm ${invalid?"border-red-500":""}`} value={leg.startUtc} onChange={e=>setLegs(ls=>ls.map(x=>x.id===leg.id?{...x,startUtc:e.target.value}:x))}/></div>
        <div className="lg:col-span-2"><label className="text-xs block">End UTC</label><input type="datetime-local" step={300} className={`w-full rounded-xl border px-3 py-2 text-sm ${invalid?"border-red-500":""}`} value={leg.endUtc} onChange={e=>setLegs(ls=>ls.map(x=>x.id===leg.id?{...x,endUtc:e.target.value}:x))}/></div>
        <div className="lg:col-span-2"><label className="text-xs block">From — Country</label><select className="w-full rounded-xl border px-3 py-2 text-sm" value={leg.from.country} onChange={e=>{const c=e.target.value;setLegs(ls=>ls.map(x=>x.id===leg.id?{...x,from:{country:c,city:cityList(c)[0]||""}}:x));}}>{allCountries.map(c=><option key={c}>{c}</option>)}</select></div>
        <div className="lg:col-span-1"><label className="text-xs block">From — City</label><select className="w-full rounded-xl border px-3 py-2 text-sm" value={cityToSelectValue(leg.from.city)} onChange={e=>setLegs(ls=>ls.map(x=>x.id===leg.id?{...x,from:{...x.from,city:selectValueToCity(e.target.value)}}:x))}>{["",...cityList(leg.from.country)].map(c=><option key={c||CITY_COUNTRY_ONLY_SENTINEL} value={cityToSelectValue(c)}>{c||"(Country rate)"}</option>)}</select></div>
        <div className="lg:col-span-2"><label className="text-xs block">To — Country</label><select className="w-full rounded-xl border px-3 py-2 text-sm" value={leg.to.country} onChange={e=>{const c=e.target.value;setLegs(ls=>ls.map(x=>x.id===leg.id?{...x,to:{country:c,city:cityList(c)[0]||""}}:x));}}>{allCountries.map(c=><option key={c}>{c}</option>)}</select></div>
        <div className="lg:col-span-1"><label className="text-xs block">To — City</label><select className="w-full rounded-xl border px-3 py-2 text-sm" value={cityToSelectValue(leg.to.city)} onChange={e=>setLegs(ls=>ls.map(x=>x.id===leg.id?{...x,to:{...x.to,city:selectValueToCity(e.target.value)}}:x))}>{["",...cityList(leg.to.country)].map(c=><option key={c||CITY_COUNTRY_ONLY_SENTINEL} value={cityToSelectValue(c)}>{c||"(Country rate)"}</option>)}</select></div>
        <div className="lg:col-span-2 flex items-center justify-end gap-2">{leg.movementType&&<Badge className={tone.badge}>{leg.movementType}</Badge>}{invalid&&<span className="text-xs text-red-600">Start must be earlier than End</span>}<Button variant="outline" className="gap-2" onClick={()=>removeLeg(leg.id)}>{leg.source==="ICS" ? <>Hide from report</> : <><IconTrash className="h-4 w-4"/> Remove</>}</Button></div>
      </div>})}
      {!reportLegs.length && <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
        No movements stored for {fl3xxFromDate} → {fl3xxToDate}.
      </div>}
      </CardContent>
    </Card>

    <Card><CardHeader><CardTitle>Calculation Preview</CardTitle></CardHeader><CardContent className="overflow-x-auto" ref={previewRef}>
      <table className="w-full text-sm"><thead><tr className="text-left border-b border-slate-200 bg-slate-50/80">
        <th className="py-2 pr-3 whitespace-nowrap">Day (UTC)</th><th className="pr-3">Start</th><th className="pr-3">End</th>
        <th className="pr-4">From</th><th className="pr-4">To</th><th className="pr-4 whitespace-nowrap">Rate</th><th className="pr-3">Type</th>
        <th className="pr-4"><div className="flex items-center gap-2"><span>Breakfast</span><label className="inline-flex items-center gap-1 text-xs font-normal text-slate-500"><input type="checkbox" checked={allBreakfastChecked} disabled={!calc.items.length} onChange={e=>setBreakfastForAll(e.target.checked)}/><span>All</span></label></div></th>
        <th className="pr-4 whitespace-nowrap">Per-Diem (€)</th><th className="whitespace-nowrap">Reason</th>
      </tr></thead><tbody>
        {calc.items.map(it=>{const full=it.dayType==="FULL";return <tr key={it.date} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/70">
          <td className="py-2 pr-3 whitespace-nowrap">{it.date}</td>
          <td className="pr-3 whitespace-nowrap">{full?"full day":hhmm(it.startUtc)}</td>
          <td className="pr-3 whitespace-nowrap">{full?"full day":hhmm(it.endUtc)}</td>
          <td className="pr-4"><span title={locLabel(it.from)} className="whitespace-nowrap font-medium text-slate-700">{compactLocLabel(it.from)}</span></td>
          <td className="pr-4"><span title={locLabel(it.to)} className="whitespace-nowrap font-medium text-slate-700">{compactLocLabel(it.to)}</span></td>
          <td className="pr-4"><span title={locLabel(it.rateLocation)} className="whitespace-nowrap font-semibold">{compactLocLabel(it.rateLocation)}</span></td>
          <td className="pr-3"><Badge className={it.dayType==="FULL"?"border-emerald-200 bg-emerald-50 text-emerald-700":it.dayType==="HALF"?"border-sky-200 bg-sky-50 text-sky-700":"border-slate-200 bg-slate-50 text-slate-600"}>{it.dayType}</Badge></td>
          <td className="pr-4"><input type="checkbox" checked={!!breakfastByDate[it.date]} onChange={e=>setBreakfastByDate(prev=>({...prev,[it.date]:e.target.checked}))}/></td>
          <td className="pr-4 font-semibold tabular-nums">{it.perDiemEUR.toFixed(2)}</td>
          <td className="text-slate-500 whitespace-nowrap" title={it.reason}>{compactReason(it)}</td>
        </tr>})}
      </tbody></table>
      {calc.warnings.length>0&&<div className="mt-3 text-xs text-amber-700">{calc.warnings.map((w,i)=><div key={i}>• {w}</div>)}</div>}
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        <div className="rounded-xl border px-3 py-2 bg-neutral-50 text-sm">
          <span className="mr-2 font-medium">Total per-diem:</span>
          <span className="font-semibold">€ {totalEUR.toFixed(2)}</span>
        </div>
        <Button className="gap-2" onClick={exportPDF}>
          Export PDF
        </Button>
      </div>
    </CardContent></Card>
  </div>
  </div>;
}
