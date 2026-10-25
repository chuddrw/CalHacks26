import { cart } from '../cart/cart';
import type { CartService } from '../contracts/cart';

/** Remove every unit of a product through the existing shared cart store. */
export function removeItem(productId: string, service: CartService = cart): void {
  if (!service.getItems().some(item => item.product.id === productId)) return;
  service.updateItems(items => items.filter(item => item.product.id !== productId));
}

/** Pass afterRender to mountCart so buttons return whenever its rows are replaced. */
export function mountCartRemoval(container: HTMLElement, service: CartService) {
  function afterRender() {
    const products = new Map(service.getItems().map(item => [item.product.id, item.product]));
    for (const cell of container.querySelectorAll<HTMLElement>('[data-cart-row-actions]')) {
      const id = cell.dataset.productId;
      const product = id === undefined ? undefined : products.get(id);
      if (!product) continue;
      const button = container.ownerDocument.createElement('button');
      button.type = 'button';
      button.className = 'cart-remove';
      button.dataset.cartRemove = product.id;
      button.textContent = 'Remove';
      button.setAttribute('aria-label', `Remove ${product.name} from cart`);
      cell.replaceChildren(button);
    }
  }

  function onClick(event: Event) {
    const target = event.target as Element | null;
    const button = target?.closest?.<HTMLButtonElement>('button[data-cart-remove]');
    if (!button || !container.contains(button)) return;
    const id = button.dataset.cartRemove;
    if (id === undefined) return;
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[data-cart-remove]')];
    const index = buttons.indexOf(button);
    removeItem(id, service);
    // Removal re-renders the row that held focus. Keep keyboard focus in the cart.
    const remaining = container.querySelectorAll<HTMLButtonElement>('[data-cart-remove]');
    const next = remaining[Math.min(index, remaining.length - 1)];
    if (next) next.focus();
    else {
      const empty = container.querySelector<HTMLElement>('[data-cart-empty]');
      if (empty) { empty.tabIndex = -1; empty.focus(); }
    }
  }

  container.addEventListener('click', onClick);
  afterRender();
  return {
    afterRender,
    destroy: () => container.removeEventListener('click', onClick),
  };
}
