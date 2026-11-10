import React from 'react';
import { createRoot } from 'react-dom/client';
import { LaboratoryPage } from '../src/client/index.js';
import styles from '../src/client/style.css';
const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
const api = async (method: string, payload = {}) => {
  const response = await fetch('/preview/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const result = await response.json(); if (!result.ok) throw new Error(result.error); return result.value;
};
createRoot(document.getElementById('root')!).render(<LaboratoryPage api={api}/>);
