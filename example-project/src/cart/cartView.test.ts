/**
 * src/cart/cartView.test.ts
 *
 * WHAT IT'S FOR
 *   Tests for the cart display: rows, prices, total, empty-cart message, the Remove-button slot,
 *   and the checkout button (disabled when empty, calls openCheckout otherwise).
 *
 * OWNER: agent a (cart).
 */
import { describe, expect, it } from "vitest";
import type { Product } from "../contracts/product";
import { createCart } from "./cart";
import { formatUsd, mountCart, renderCartHtml } from "./cartView";

const mug: Product = { id: "mug", name: "Mug", description: "A mug", image: "mug.png", priceCents: 1299 };
const tee: Product = { id: "tee", name: "<T-shirt>", description: "A tee", image: "tee.png", priceCents: 2000 };

describe("formatUsd", () => {
  it("formats integer cents as dollars", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(5)).toBe("$0.05");
    expect(formatUsd(1299)).toBe("$12.99");
    expect(formatUsd(250000)).toBe("$2500.00");
  });
});

describe("renderCartHtml", () => {
  it("shows the empty-cart message and a disabled checkout button when empty", () => {
    const html = renderCartHtml([]);
    expect(html).toContain("Your cart is empty.");
    expect(html).toMatch(/<button[^>]*data-cart-checkout disabled/);
    expect(html).not.toContain("data-cart-row");
  });

  it("shows name, quantity, unit price, line total and the cart total", () => {
    const cart = createCart();
    cart.addItem(mug);
    cart.addItem(mug);
    cart.addItem(tee);
    const html = renderCartHtml(cart.getItems());
    expect(html).toContain("<td>Mug</td><td data-cart-quantity>2</td>");
    expect(html).toContain("<td data-cart-unit-price>$12.99</td><td data-cart-line-total>$25.98</td>");
    expect(html).toContain("<td data-cart-unit-price>$20.00</td><td data-cart-line-total>$20.00</td>");
    expect(html).toContain("<strong data-cart-total>$45.98</strong>");
    expect(html).not.toContain("Your cart is empty.");
    expect(html).not.toMatch(/data-cart-checkout disabled/);
  });

  it("escapes product names", () => {
    expect(renderCartHtml([{ product: tee, quantity: 1 }])).toContain("&lt;T-shirt&gt;");
  });

  it("gives each row an actions cell for the Remove button", () => {
    const html = renderCartHtml([{ product: mug, quantity: 1 }]);
    expect(html).toContain('<td data-cart-row-actions data-product-id="mug"></td>');
  });
});

/** A minimal stand-in for an element, since the tests run in plain Node. */
function fakeContainer() {
  let handler: ((e: Event) => void) | undefined;
  const el = {
    innerHTML: "",
    addEventListener: (_: string, h: (e: Event) => void) => (handler = h),
    removeEventListener: () => (handler = undefined),
    click(disabled: boolean) {
      const button = { disabled };
      handler?.({ target: { closest: () => button } } as unknown as Event);
    },
  };
  return el;
}

describe("mountCart", () => {
  it("re-renders on every cart change", () => {
    const cart = createCart();
    const el = fakeContainer();
    mountCart(el as unknown as HTMLElement, cart, { openCheckout: () => {} });
    expect(el.innerHTML).toContain("Your cart is empty.");
    cart.addItem(mug);
    expect(el.innerHTML).toContain("<strong data-cart-total>$12.99</strong>");
    cart.clearCart();
    expect(el.innerHTML).toContain("Your cart is empty.");
  });

  it("calls openCheckout from the checkout button only when the cart has items", () => {
    const cart = createCart();
    const el = fakeContainer();
    let opened = 0;
    mountCart(el as unknown as HTMLElement, cart, { openCheckout: () => opened++ });
    el.click(true);
    expect(opened).toBe(0);
    cart.addItem(mug);
    el.click(false);
    expect(opened).toBe(1);
  });

  it("runs afterRender so removal can fill the actions cells", () => {
    const cart = createCart();
    const el = fakeContainer();
    let renders = 0;
    mountCart(el as unknown as HTMLElement, cart, { openCheckout: () => {}, afterRender: () => renders++ });
    cart.addItem(mug);
    expect(renders).toBe(2);
  });
});
