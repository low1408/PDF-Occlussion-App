import { useState, useEffect, useRef } from 'react';
import { useOcclusionStore } from './store/useOcclusionStore';
import PdfViewer from './components/PdfViewer';
import './index.css';

function App() {
  const [fileData, setFileData] = useState<ArrayBuffer | null>(null);
  const [fileHash, setFileHash] = useState<string>('');
  const loadBoxesForDocument = useOcclusionStore(state => state.loadBoxesForDocument);

  useEffect(() => {
    if (fileHash) {
      loadBoxesForDocument(fileHash);
    }
  }, [fileHash, loadBoxesForDocument]);

  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL('./syncWorker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    return () => worker.terminate();
  }, []);

  const handleSync = () => {
    workerRef.current?.postMessage('sync');
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const buffer = await file.arrayBuffer();
      setFileData(buffer);
      // Generate SHA-256 for Document ID
      const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      setFileHash(hashHex);
    }
  };

  return (
    <div className="app-container">
      {!fileData ? (
        <div className="upload-container">
          <h1>PDF Occlusion Engine</h1>
          <p>Select a PDF to begin studying</p>
          <input type="file" accept="application/pdf" onChange={handleFileChange} />
        </div>
      ) : (
        <PdfViewer fileData={fileData} fileHash={fileHash} onSync={handleSync} />
      )}
    </div>
  );
}

export default App;
