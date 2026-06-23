// The "197" country list: 193 UN members + 2 UN observer states (Vatican, Palestine)
// + Taiwan + Kosovo. Keyed by ISO 3166-1 alpha-2. This is the denominator for stats
// and the allowlist applied to the Natural Earth admin-0 layer during curation.

export const UN_MEMBERS = [
  "AF","AL","DZ","AD","AO","AG","AR","AM","AU","AT","AZ",
  "BS","BH","BD","BB","BY","BE","BZ","BJ","BT","BO","BA","BW","BR","BN","BG","BF","BI",
  "CV","KH","CM","CA","CF","TD","CL","CN","CO","KM","CG","CD","CR","CI","HR","CU","CY","CZ",
  "DK","DJ","DM","DO","EC","EG","SV","GQ","ER","EE","SZ","ET",
  "FJ","FI","FR","GA","GM","GE","DE","GH","GR","GD","GT","GN","GW","GY",
  "HT","HN","HU","IS","IN","ID","IR","IQ","IE","IL","IT",
  "JM","JP","JO","KZ","KE","KI","KP","KR","KW","KG",
  "LA","LV","LB","LS","LR","LY","LI","LT","LU",
  "MG","MW","MY","MV","ML","MT","MH","MR","MU","MX","FM","MD","MC","MN","ME","MA","MZ","MM",
  "NA","NR","NP","NL","NZ","NI","NE","NG","MK","NO","OM",
  "PK","PW","PA","PG","PY","PE","PH","PL","PT","QA",
  "RO","RU","RW","KN","LC","VC","WS","SM","ST","SA","SN","RS","SC","SL","SG","SK","SI","SB","SO","ZA","SS","ES","LK","SD","SR","SE","CH","SY",
  "TJ","TZ","TH","TL","TG","TO","TT","TN","TR","TM","TV",
  "UG","UA","AE","GB","US","UY","UZ","VU","VE","VN","YE","ZM","ZW",
];

export const OBSERVERS = ["VA", "PS"]; // Holy See (Vatican), State of Palestine
export const EXTRAS = ["TW", "XK"]; // Taiwan, Kosovo

export const ISO_197 = [...new Set([...UN_MEMBERS, ...OBSERVERS, ...EXTRAS])];

// Natural Earth tags some entities with ISO_A2 = "-99". Resolve by ADMIN name.
export const NAME_PATCHES = {
  "Kosovo": "XK",
  "Palestine": "PS",
  "Northern Cyprus": null, // intentionally excluded
  "Somaliland": null,
};
