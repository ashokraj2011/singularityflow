# Repository brief: shop at 8508ce5b8d07 (for verification, focused on this Story)

## Rules that apply
- shipping: when `subtotal(cart) >= FREE_SHIPPING_THRESHOLD_CENTS` → returns `0`. Not documented, enforced, tested. (pricing.ts:13)
- total: computes `subtotal(cart) - couponDiscount(cart, code, isMember) + shipping(cart)`. Not documented, enforced, tested. (pricing.ts:29)
- WORK-1:AC-001: A shopper who is not a member cannot use the VIP20 coupon. Documented; no code enforcing it was found. (spec.md › WORK-1:AC-001)
- couponDiscount: when `code === 'VIP20'` and `!isMember` → refuses "VIP20 is for members only". Not documented, enforced, tested. (pricing.ts:22)
- couponDiscount: when `code === 'SAVE10' && base >= 3000` → returns `Math.round(base * 0.1)`. Not documented, enforced, tested. (pricing.ts:20)
- subtotal: computes `cart.lines.reduce((sum, line) => sum + line.priceCents * line.quantity, 0)`. Not documented, enforced. (pricing.ts:9)
- cartReducer: when `action.type is 'setQuantity'` → does `const quantity = Math.min(Math.max(action.quantity, 0), MAX_QUANTITY_PER_LINE)`. Not documented, enforced, tested. (cart.ts:24)
- handleSubmit: when `cart.lines.length === 0` → shows "Your cart is empty.". Not documented, enforced. (CheckoutForm.tsx:15)
- couponDiscount: when `code === 'VIP20'` → checks `!isMember`. Not documented, enforced, tested. (pricing.ts:21)

## Risks
- couponDiscount: test and code disagree: the test title says "more than" (strict), the code uses >= (pricing.ts)
- couponDiscount: 4 rules (pricing.ts:17)

## What a change touches
- shipping (changed): 1 rule (pricing.ts:12)

Not known: calls are matched by name (no semantic pack is warmed), so who calls what and which tests reach it are left out; no runtime or incident data.
Read without a model from the committed source. Open the cited lines before relying on a detail.
