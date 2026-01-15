import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from './button';

describe('Button', () => {
  it('calls onClick when clicked and respects disabled', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click</Button>);
    const btn = screen.getByText('Click');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();

    render(<Button disabled>Disabled</Button>);
    const d = screen.getByText('Disabled');
    expect(d.closest('button')).toBeDisabled();
  });
});
