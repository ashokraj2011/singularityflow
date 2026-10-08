import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { ShopPage } from './pages/ShopPage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ShopPage isMember={false} />} />
        <Route path="/members" element={<ShopPage isMember />} />
      </Routes>
    </BrowserRouter>
  );
}
