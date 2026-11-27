import { PaymentRule } from '@prisma/client';

export interface ResolvedPricingAdjustment {
  coefficient: number;
  unitPrice: number;
  discountPercentage: number;
  interestPercentage: number;
  appliedRuleId: string | null;
}

type EnrichedPaymentRule = PaymentRule & {
  category?: { slug?: string | null; path?: string | null } | null;
};

export class PricingEngine {
  static resolveProductRule(
    product: {
      id: string;
      category_id?: string | null;
      category?: { id?: string | null; slug?: string | null; path?: string | null } | null;
    },
    activeRules: EnrichedPaymentRule[],
    paymentMethod: string,
    installments: number = 1
  ): EnrichedPaymentRule | null {
    const matchingRules = activeRules.filter(
      (rule) =>
        rule.is_active !== false &&
        rule.payment_method === paymentMethod &&
        Number(rule.installments) === Number(installments) &&
        this.getRuleScore(rule, product) > 0
    );

    let bestRule: EnrichedPaymentRule | null = null;
    let bestScore = 0;

    for (const rule of matchingRules) {
      const score = this.getRuleScore(rule, product);
      if (score > bestScore) {
        bestScore = score;
        bestRule = rule;
      }
    }

    return bestRule;
  }

  static calculateEffectiveUnitPrice(
    product: {
      id: string;
      base_price: any;
      category_id?: string | null;
      category?: { id?: string | null; slug?: string | null; path?: string | null } | null;
    },
    activeRules: EnrichedPaymentRule[],
    paymentMethod?: string,
    installments: number = 1
  ): ResolvedPricingAdjustment {
    const basePrice = parseFloat(product.base_price.toString());

    if (!paymentMethod) {
      return {
        coefficient: 1,
        unitPrice: basePrice,
        discountPercentage: 0,
        interestPercentage: 0,
        appliedRuleId: null,
      };
    }

    const rule = this.resolveProductRule(product, activeRules, paymentMethod, installments);
    if (!rule) {
      return {
        coefficient: 1,
        unitPrice: basePrice,
        discountPercentage: 0,
        interestPercentage: 0,
        appliedRuleId: null,
      };
    }

    const coeff = parseFloat(rule.coefficient.toString());
    const adjustedUnitPrice = Math.round(basePrice * coeff * 100) / 100;
    const discountPercentage = coeff < 1 ? Math.round((1 - coeff) * 100) : 0;
    const interestPercentage = coeff > 1 ? Math.round((coeff - 1) * 100) : 0;

    return {
      coefficient: coeff,
      unitPrice: adjustedUnitPrice,
      discountPercentage,
      interestPercentage,
      appliedRuleId: rule.id,
    };
  }

  static applyDynamicPricing(products: any[], activeRules: EnrichedPaymentRule[]): any[] {
    if (products.length === 0) return [];

    return products.map((product) => {
      const basePrice = parseFloat(product.base_price.toString());

      const applicableRules = activeRules.filter(
        (rule) => rule.is_active !== false && this.getRuleScore(rule, product) > 0
      );

      const resolvedRules = new Map<string, EnrichedPaymentRule>();

      for (const rule of applicableRules) {
        const key = `${rule.payment_method}_${rule.installments}`;
        const currentRule = resolvedRules.get(key);

        const newScore = this.getRuleScore(rule, product);
        const currentScore = currentRule ? this.getRuleScore(currentRule, product) : 0;

        if (newScore > currentScore) {
          resolvedRules.set(key, rule);
        }
      }

      const dynamic_pricing: any = { credit_card: [], payment_methods: {} };

      for (const rule of resolvedRules.values()) {
        const coeff = parseFloat(rule.coefficient.toString());
        const finalTotal = parseFloat((basePrice * coeff).toFixed(2));
        const discountPct = coeff < 1 ? Math.round((1 - coeff) * 100) : 0;
        const interestPct = coeff > 1 ? Math.round((coeff - 1) * 100) : 0;

        dynamic_pricing.payment_methods[`${rule.payment_method}_${rule.installments}`] = {
          gateway: rule.payment_method,
          installments: rule.installments,
          coefficient: coeff,
          final_total: finalTotal,
          discount_percentage: discountPct,
          interest_percentage: interestPct,
        };

        if (rule.payment_method === 'TRANSFERENCIA') {
          dynamic_pricing.cash_transfer = {
            discount_percentage: discountPct,
            final_total: finalTotal,
            label:
              discountPct > 0
                ? `${discountPct}% OFF por transferencia`
                : 'Transferencia bancaria',
          };
        } else if (rule.payment_method === 'MOBBEX' || rule.payment_method === 'MP') {
          dynamic_pricing.credit_card.push({
            gateway: rule.payment_method,
            installments: rule.installments,
            installment_amount: parseFloat((finalTotal / rule.installments).toFixed(2)),
            final_total: finalTotal,
            discount_percentage: discountPct,
            interest_percentage: interestPct,
          });
        }
      }

      dynamic_pricing.credit_card.sort((a: any, b: any) => a.installments - b.installments);

      return {
        ...product,
        dynamic_pricing,
      };
    });
  }

  private static getRuleScore(
    rule: EnrichedPaymentRule,
    product: {
      id: string;
      category_id?: string | null;
      category?: { id?: string | null; slug?: string | null; path?: string | null } | null;
    }
  ): number {
    if (rule.product_id && rule.product_id === product.id) {
      return 1000;
    }

    if (rule.category_id) {
      const productCategoryId = product.category_id || product.category?.id || null;
      if (productCategoryId && rule.category_id === productCategoryId) {
        return 500;
      }

      const pathSegments = (product.category?.path || '')
        .split('/')
        .map((s) => s.trim())
        .filter(Boolean);

      const idIndex = pathSegments.indexOf(rule.category_id);
      if (idIndex !== -1) {
        return 10 + (idIndex + 1);
      }

      const ruleCategorySlug = rule.category?.slug;
      if (ruleCategorySlug) {
        const slugIndex = pathSegments.indexOf(ruleCategorySlug);
        if (slugIndex !== -1) {
          return 10 + (slugIndex + 1);
        }
      }
    }

    if (rule.is_global) {
      return 1;
    }

    return 0;
  }
}