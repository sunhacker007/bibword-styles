import { FATF_BLACKLIST, FATF_GREYLIST } from "./aml.js";

export function assessKYC(customer) {
  const {
    amlScore = 0,
    monthlyLimitUSD = 1000,
    country = "SG",
    productType = "regular",
    isPEP = false,
    hasSanctionHit = false,
  } = customer;

  if (hasSanctionHit) {
    return {
      tier: "REJECT", tierLabel: "直接拒绝",
      reason: "制裁名单精确命中",
      action: "立即冻结账户，30日内评估是否提交SAR",
      checks: [], targetTime: "N/A",
    };
  }

  if (isPEP || amlScore >= 70 || monthlyLimitUSD > 50000 || FATF_BLACKLIST.includes(country)) {
    const reasons = [];
    if (isPEP) reasons.push("PEP身份确认");
    if (amlScore >= 70) reasons.push(`AML评分 ${amlScore} ≥ 70`);
    if (monthlyLimitUSD > 50000) reasons.push(`月限额 $${monthlyLimitUSD} > $50,000`);
    if (FATF_BLACKLIST.includes(country)) reasons.push(`${country} 为FATF黑名单`);
    return {
      tier: "EDD", tierLabel: "强化尽职调查",
      reason: reasons.join("；"),
      action: "需要CCO审批，48小时内完成",
      checks: [
        "CDD全套文件",
        "财富来源证明（税单/工资单/营业执照，需2份）",
        "业务关系目的声明",
        "高管审批签字",
        "每6个月定期复核",
      ],
      targetTime: "目标：2个工作日",
    };
  }

  const isSDD =
    amlScore < 20 && monthlyLimitUSD <= 500 &&
    !FATF_GREYLIST.includes(country) && !FATF_BLACKLIST.includes(country) &&
    productType !== "BNPL" && !isPEP;

  if (isSDD) {
    return {
      tier: "SDD", tierLabel: "简化尽职调查",
      reason: `低风险（AML ${amlScore}，月限额 $${monthlyLimitUSD}，低风险地区）`,
      action: "全自动处理，无需人工",
      checks: [
        "有效政府ID（OCR，置信度≥92%）",
        "手机OTP验证",
        "设备指纹",
        "制裁名单精确匹配",
      ],
      targetTime: "目标：< 3分钟",
    };
  }

  const reasons = [];
  if (amlScore >= 20) reasons.push(`AML评分 ${amlScore}`);
  if (monthlyLimitUSD > 500) reasons.push(`月限额 $${monthlyLimitUSD}`);
  if (FATF_GREYLIST.includes(country)) reasons.push(`${country} 为FATF灰名单`);
  if (productType === "BNPL") reasons.push("BNPL产品");

  return {
    tier: "CDD", tierLabel: "标准尽职调查",
    reason: reasons.join("；") || "默认标准核查",
    action: "AI自动处理，置信度<85%时转人工",
    checks: [
      "有效政府ID（OCR + MRZ码 + 防伪）",
      "地址证明（近3个月）",
      "自拍活体检测",
      "PEP数据库筛查",
      "制裁名单模糊匹配",
      "业务性质声明",
    ],
    targetTime: "目标：P50 < 25分钟",
  };
}
