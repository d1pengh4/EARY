import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { connect, useStore } from './store';
import './styles.css';

connect();
// 테스트용 손잡이: localhost에서만 (Chrome 자동 테스트가 문장 주입·상태 확인에 쓴다)
if (['localhost', '127.0.0.1'].includes(location.hostname)) (window as unknown as { __eary: typeof useStore }).__eary = useStore;
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
