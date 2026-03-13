export const FATF_BLACKLIST = ["IR", "KP", "MM", "YE"];
export const FATF_GREYLIST = ["PK", "SY", "TR", "VN", "PH", "NG", "EG", "TZ", "BF"];

export function runAMLRules(tx) {
  const {
    amount = 0,
    counterpartyCountry = "",
    accountAgeDays = 365,
    hourlyTxCount = 0,
    percentOutWithin30Min = 0,
    sanctionsHit = false,
  } = tx;

  const hits = [];
  let score = 0;

  const add = (id, name, pts) => { hits.push({ id, name, score: pts }); score += pts; };

  if (amount >= 9500 && amount <= 9999) add("A1", `CTR门槛规避（$${amount}）`, 25);
  else if (amount >= 10001 && amount <= 10100) add("A1", `CTR门槛上方小额分拆（$${amount}）`, 25);

  if (amount > 50000) add("A2", `大额异常（$${amount} > $50,000）`, 20);

  if (hourlyTxCount >= 5) add("B1", `1小时高频（${hourlyTxCount}笔）`, 18);

  if (percentOutWithin30Min >= 90)
    add("B2", `快速转出（30分钟内 ${percentOutWithin30Min}%）`, 22);

  if (accountAgeDays < 30 && amount > 5000)
    add("B3", `新账户大额（${accountAgeDays}天，$${amount}）`, 15);

  if (FATF_BLACKLIST.includes(counterpartyCountry))
    add("G1", `FATF黑名单对手方（${counterpartyCountry}）`, 30);
  else if (FATF_GREYLIST.includes(counterpartyCountry))
    add("G2", `FATF灰名单对手方（${counterpartyCountry}）`, 15);

  if (sanctionsHit) add("I1", "制裁名单命中", 40);

  score = Math.min(score, 100);

  let decision, decisionLevel;
  if (score < 30)       { decision = "放行";     decisionLevel = "low"; }
  else if (score < 70)  { decision = "人工复核"; decisionLevel = "medium"; }
  else                  { decision = "自动阻断"; decisionLevel = "high"; }

  return { score, hits, decision, decisionLevel };
}
