import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import App from './App.jsx';

describe('App', () => {
  it('renders the calculator', () => { expect(render(<App />).container).toBeTruthy(); });
});
