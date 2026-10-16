import { PaymentRule } from '@prisma/client';

export class PricingEngine {

  static applyDynamicPricing(products: any[], activeRules: PaymentRule[]): any[] {
    if (products.length === 0) return [];

    return products.map(product => {
      const basePrice = parseFloat(product.base_price.toString());
      
      const applicableRules = activeRules.filter(rule => 
        rule.is_global === true || 
        rule.category_id === product.category_id || 
        rule.product_id === product.id
      );

      const resolvedRules = new Map<string, PaymentRule>();

      for (const rule of applicableRules) {
        const key = `${rule.payment_method}_${rule.installments}`;
        const currentRule = resolvedRules.get(key);
        
        const newScore = this.getRuleScore(rule, product.id, product.category_id);
        const currentScore = currentRule ? this.getRuleScore(currentRule, product.id, product.category_id) : 0;

        if (newScore > currentScore) {
          resolvedRules.set(key, rule);
        }
      }

      const dynamic_pricing: any = { credit_card: [] };

      for (const rule of resolvedRules.values()) {
        const coeff = parseFloat(rule.coefficient.toString());
        const finalTotal = basePrice * coeff;

        if (rule.payment_method === 'TRANSFERENCIA') {
          const discountPct = Math.round((1 - coeff) * 100);
          dynamic_pricing.cash_transfer = {
            discount_percentage: discountPct,
            final_total: parseFloat(finalTotal.toFixed(2)),
            label: `${discountPct}% OFF por transferencia`
          };
        } else if (rule.payment_method === 'MOBBEX' || rule.payment_method === 'MP') {
          const interestPct = Math.round((coeff - 1) * 100);
          dynamic_pricing.credit_card.push({
            gateway: rule.payment_method,
            installments: rule.installments,
            installment_amount: parseFloat((finalTotal / rule.installments).toFixed(2)),
            final_total: parseFloat(finalTotal.toFixed(2)),
            interest_percentage: interestPct
          });
        }
      }

      dynamic_pricing.credit_card.sort((a: any, b: any) => a.installments - b.installments);

      return {
        ...product,
        dynamic_pricing
      };
    });
  }

  private static getRuleScore(rule: PaymentRule, productId: string, categoryId: string | null): number {
    if (rule.product_id === productId) return 3; 
    if (rule.category_id && rule.category_id === categoryId) return 2; 
    if (rule.is_global) return 1; 
    return 0;
  }
}