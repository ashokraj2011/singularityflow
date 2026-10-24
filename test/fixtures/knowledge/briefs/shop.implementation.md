# Repository brief: shop at 8508ce5b8d07 (for implementation, focused on this Story)

## What a change touches
- shipping (changed): called by total; 1 rule; tested by pricing.test.ts (pricing.ts:12)

## Rules that apply
- shipping: when `subtotal(cart) >= FREE_SHIPPING_THRESHOLD_CENTS` → returns `0`. Not documented, enforced, tested. (pricing.ts:13)
- total: computes `subtotal(cart) - couponDiscount(cart, code, isMember) + shipping(cart)`. Not documented, enforced, tested. (pricing.ts:29)
- WORK-1:AC-001: A shopper who is not a member cannot use the VIP20 coupon. Documented; no code enforcing it was found. (spec.md › WORK-1:AC-001)
- couponDiscount: when `code === 'VIP20'` and `!isMember` → refuses "VIP20 is for members only". Not documented, enforced, tested. (pricing.ts:22)
- couponDiscount: when `code === 'SAVE10' && base >= 3000` → returns `Math.round(base * 0.1)`. Not documented, enforced, tested. (pricing.ts:20)
- couponDiscount: when `code === 'VIP20'` → checks `!isMember`. Not documented, enforced, tested. (pricing.ts:21)

## Contracts
- Calls GET /products via request (orders.ts:14)
- Calls POST /orders via request (orders.ts:7)

## Risks
- couponDiscount: test and code disagree: the test title says "more than" (strict), the code uses >= (pricing.ts)
- couponDiscount: reached by 1 entry point, called from 2 places, 4 rules (pricing.ts:17)
- subtotal: reached by 1 entry point, called from 3 places (pricing.ts:8)
- handleSubmit: reached by 1 entry point, no test reaches it (CheckoutForm.tsx:13)

- … 3 more: singularity-flow wm brief --phase implementation

Not known: calls are matched by name (no semantic pack is warmed); no runtime or incident data.
Read without a model from the committed source. Open the cited lines before relying on a detail.
