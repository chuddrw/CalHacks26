/**
 * src/cart/cartView.ts
 *
 * WHAT IT'S FOR
 *   The cart display: one row per item (name, quantity, unit price, line total), the total, an
 *   empty-cart message, and a checkout button that is disabled when the cart is empty.
 *   Each row ends with an empty <td data-cart-row-actions data-product-id="..."> where the
 *   removal feature puts its Remove button.
 *
 * OWNER: agent a (cart).
 */
import type { CartItem, CartService } from "../contracts/cart";

export function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderCartHtml(items: readonly CartItem[]): string {
  const totalCents = items.reduce((sum, i) => sum + i.product.priceCents * i.quantity, 0);
  const checkout = `<button type="button" data-cart-checkout${items.length === 0 ? " disabled" : ""}>Checkout</button>`;

  if (items.length === 0) {
    return `<section class="cart"><p data-cart-empty>Your cart is empty.</p>${checkout}</section>`;
  }

  const rows = items
    .map((item) => {
      const id = escapeHtml(item.product.id);
      return (
        `<tr data-cart-row data-product-id="${id}">` +
        `<td>${escapeHtml(item.product.name)}</td>` +
        `<td data-cart-quantity>${item.quantity}</td>` +
        `<td data-cart-unit-price>${formatUsd(item.product.priceCents)}</td>` +
        `<td data-cart-line-total>${formatUsd(item.product.priceCents * item.quantity)}</td>` +
        `<td data-cart-row-actions data-product-id="${id}"></td>` +
        `</tr>`
      );
    })
    .join("");

  return (
    `<section class="cart"><table>` +
    `<thead><tr><th>Item</th><th>Qty</th><th>Unit price</th><th>Line total</th><th></th></tr></thead>` +
    `<tbody>${rows}</tbody></table>` +
    `<p>Total: <strong data-cart-total>${formatUsd(totalCents)}</strong></p>` +
    `${checkout}</section>`
  );
}

export interface MountCartOptions {
  /** The payment feature's openCheckout(). */
  openCheckout: () => void;
  /** Runs after each render, e.g. so removal can fill the [data-cart-row-actions] cells. */
  afterRender?: (container: HTMLElement) => void;
}

/** Renders the cart into container and re-renders on every cart change. Returns unmount. */
export function mountCart(
  container: HTMLElement,
  service: CartService,
  options: MountCartOptions,
): () => void {
  const render = (items: readonly CartItem[]) => {
    container.innerHTML = renderCartHtml(items);
    options.afterRender?.(container);
  };
  const onClick = (event: Event) => {
    const target = event.target as Element | null;
    const button = target?.closest?.("[data-cart-checkout]") as HTMLButtonElement | null;
    if (button && !button.disabled && service.getItems().length > 0) options.openCheckout();
  };
  container.addEventListener("click", onClick);
  render(service.getItems());
  const unsubscribe = service.subscribe(render);
  return () => {
    unsubscribe();
    container.removeEventListener("click", onClick);
  };
}
