import { useState, useEffect, useRef } from 'react';
import { Authenticator, useAuthenticator } from '@aws-amplify/ui-react';
import { fetchAuthSession } from 'aws-amplify/auth';

function Dashboard() {
  const { signOut, user } = useAuthenticator((context) => [context.user]);
  const [meals, setMeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  
  // Upload states
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInputRef = useRef(null);
  const [successMsg, setSuccessMsg] = useState(null);

  // Daily Target Tracker states
  const [baseTarget, setBaseTarget] = useState(2200);
  const [isActiveDay, setIsActiveDay] = useState(false);

  // Delete states
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const API_URL = "https://ehqdr4gq14.execute-api.us-east-1.amazonaws.com/meals";
  const BASE_API = API_URL.replace('/meals', '');

  useEffect(() => {
    fetchMeals();
  }, []);

  const fetchMeals = async () => {
    try {
      const session = await fetchAuthSession();
      const token = session.tokens.idToken.toString();

      const response = await fetch(API_URL, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (response.status === 401 || response.status === 403) {
        throw new Error('SESSION_TERMINATED: UNAUTHORIZED ACCESS');
      }
      if (!response.ok) throw new Error('SYS_ERR: DATA FETCH FAILED');
      const data = await response.json();
      setMeals(data);
      setLoading(false);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.type.match('image/jpeg')) {
        setError('SYS_ERR: ONLY JPEG UPLOADS SUPPORTED');
        return;
    }

    setUploading(true);
    setError(null);
    setSuccessMsg(null);
    setUploadProgress(0);
    
    try {
        const session = await fetchAuthSession();
        const token = session.tokens.idToken.toString();

        // 1. Get Presigned URL
        const urlResponse = await fetch(`${BASE_API}/upload-url`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        
        if (!urlResponse.ok) throw new Error('FAILED TO ACQUIRE UPLOAD VECTOR');
        const { uploadUrl } = await urlResponse.json();

        setUploadProgress(10); // Acquired URL

        // 2. Upload directly to S3
        const uploadResponse = await fetch(uploadUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': 'image/jpeg'
            },
            body: file
        });

        if (!uploadResponse.ok) throw new Error('DATA STREAM TRANSFER FAILED');

        // 3. Trigger API Gateway Proxy to Step Function
        setUploadProgress(50);
        const bucketName = new URL(uploadUrl).hostname.split('.')[0];
        
        const processResponse = await fetch(API_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ bucket: bucketName, key: key })
        });

        if (!processResponse.ok) {
            const errBody = await processResponse.json().catch(() => ({}));
            throw new Error(`PROCESSING FAILED: ${errBody.message || processResponse.statusText}`);
        }

        setUploadProgress(100);
        const newMeal = await processResponse.json();
        
        // Instant UI Update
        setMeals(prev => [newMeal, ...prev]);
        
        // Temporary Success Message
        setSuccessMsg(`Receipt processed! Added ${newMeal.totalCalories || 0} KCAL.`);
        setTimeout(() => setSuccessMsg(null), 5000);
        
    } catch (err) {
        setError(err.message);
    } finally {
        setUploading(false);
        setUploadProgress(0);
        // Reset file input
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    }
  };

  const handleDelete = async (receiptId) => {
    setDeletingId(receiptId);
    try {
      const session = await fetchAuthSession();
      const token = session.tokens.idToken.toString();

      const response = await fetch(`${BASE_API}/meals`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ receiptId })
      });

      if (!response.ok) throw new Error('PURGE OPERATION FAILED');

      // Optimistic removal from local state
      setMeals(prev => prev.filter(m => m.receiptId !== receiptId));
      setConfirmDeleteId(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingId(null);
    }
  };

  const totalCal = meals.reduce((acc, curr) => acc + (parseInt(curr.totalCalories) || 0), 0);

  // Daily Target Tracker calculations
  const today = new Date().toISOString().split('T')[0];
  const todayMeals = meals.filter(m => m.processedAt && m.processedAt.startsWith(today));
  const todayTotalCalories = todayMeals.reduce((acc, curr) => acc + (parseInt(curr.totalCalories) || 0), 0);
  const dailyTarget = isActiveDay ? baseTarget + 400 : baseTarget;
  const progressPercent = Math.min((todayTotalCalories / dailyTarget) * 100, 100);
  const isOver = todayTotalCalories > dailyTarget;
  const overageAmount = isOver ? todayTotalCalories - dailyTarget : 0;

  return (
    <div className="min-h-screen p-4 md:p-8 max-w-7xl mx-auto text-gray-100 font-mono flex flex-col">
      <header className="mb-8 border-b-2 border-surfaceBorder pb-6 flex flex-col md:flex-row justify-between items-start md:items-end gap-4 animate-slide-up">
        <div>
          <p className="text-accent text-sm font-bold tracking-widest mb-1 flex items-center">
            <span className="w-2 h-2 bg-accent inline-block mr-2 animate-pulse"></span>
            SYSTEM ONLINE
          </p>
          <h1 className="text-6xl md:text-8xl display-font text-white uppercase leading-none">
            SnapTrack<span className="text-accent">.AI</span>
          </h1>
          <p className="text-gray-500 mt-2 tracking-widest uppercase text-xs">
            [ ID: {user?.userId || 'UNKNOWN'} ] // SERVERLESS CALORIE INTELLIGENCE
          </p>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-right hidden md:block">
            <p className="text-gray-500 text-xs uppercase tracking-widest mb-1">Total Output</p>
            <p className="display-font text-4xl text-white">{totalCal} <span className="text-accent text-xl">KCAL</span></p>
          </div>
          <button 
            onClick={signOut} 
            className="industrial-button px-6 py-3 text-sm"
          >
            TERMINATE SESSION
          </button>
        </div>
      </header>

      {/* Daily Target Tracker */}
      <section className="mb-8 animate-slide-up delay-100">
        <div className="bg-surface border border-surfaceBorder p-6">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4">
            <div className="flex items-baseline gap-4">
              <p className="text-[10px] text-gray-600 uppercase tracking-[0.2em]">Daily Target</p>
              <p className="display-font text-3xl text-white">
                {todayTotalCalories}
                <span className="text-gray-500 text-lg mx-1">/</span>
                {dailyTarget}
                <span className="text-accent text-sm ml-1">KCAL</span>
              </p>
              {isOver && (
                <span className="text-red-400 text-xs font-bold tracking-widest animate-pulse">+{overageAmount} OVER</span>
              )}
            </div>
            <button
              onClick={() => setIsActiveDay(!isActiveDay)}
              className={`flex items-center gap-3 px-4 py-2 border text-xs uppercase tracking-widest font-bold transition-all ${
                isActiveDay
                  ? 'border-accent text-accent bg-accent/10'
                  : 'border-surfaceBorder text-gray-500 hover:border-gray-400 hover:text-gray-300'
              }`}
            >
              <div className={`w-8 h-4 rounded-full relative transition-all ${
                isActiveDay ? 'bg-accent' : 'bg-surfaceBorder'
              }`}>
                <div className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${
                  isActiveDay ? 'right-0.5 bg-black' : 'left-0.5 bg-gray-500'
                }`}></div>
              </div>
              ACTIVE DAY (+400 KCAL)
            </button>
          </div>
          <div className="w-full h-3 bg-[#0a0a0a] border border-surfaceBorder relative overflow-hidden">
            <div
              className={`absolute top-0 left-0 h-full transition-all duration-700 ease-out ${
                isOver
                  ? 'bg-gradient-to-r from-red-700 to-red-500'
                  : 'bg-gradient-to-r from-accent/70 to-accent'
              }`}
              style={{ width: `${isOver ? 100 : progressPercent}%` }}
            ></div>
          </div>
          <div className="flex justify-between mt-2">
            <span className="text-[10px] text-gray-600 uppercase tracking-[0.15em]">{todayMeals.length} ENTRIES TODAY</span>
            <span className="text-[10px] text-gray-600 uppercase tracking-[0.15em]">{Math.round(progressPercent)}%</span>
          </div>
        </div>
      </section>

      {successMsg && (
        <div className="bg-accent/20 border border-accent p-6 animate-slide-up delay-100 relative overflow-hidden mb-8">
          <div className="absolute top-0 left-0 w-1 h-full bg-accent"></div>
          <h2 className="display-font text-3xl text-accent mb-2">OPERATION SUCCESSFUL</h2>
          <p className="text-white font-mono text-sm uppercase">{successMsg}</p>
        </div>
      )}

      {/* Upload Component */}
      <section className="mb-12 animate-slide-up delay-100">
        <div className="relative border-2 border-dashed border-surfaceBorder bg-surface p-8 text-center transition-all hover:border-accent group">
            <input 
                type="file" 
                accept="image/jpeg"
                onChange={handleFileUpload}
                ref={fileInputRef}
                disabled={uploading}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed z-10"
            />
            
            {!uploading ? (
                <div className="flex flex-col items-center justify-center space-y-4">
                    <div className="w-16 h-16 rounded-full bg-surfaceBorder flex items-center justify-center text-gray-400 group-hover:bg-accent group-hover:text-black transition-colors">
                        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth="2" d="M12 4v16m8-8H4"></path>
                        </svg>
                    </div>
                    <div>
                        <p className="text-white text-lg font-bold tracking-wider uppercase">INITIALIZE MANUAL SCAN</p>
                        <p className="text-gray-500 text-sm mt-1 uppercase tracking-widest">DROP JPEG IMAGE HERE OR CLICK TO BROWSE</p>
                    </div>
                </div>
            ) : (
                <div className="flex flex-col items-center justify-center space-y-6">
                    <p className="text-accent text-xl font-bold tracking-widest uppercase animate-pulse">PROCESSING INTELLIGENCE...</p>
                    
                    {/* Progress Bar */}
                    <div className="w-full max-w-md h-2 bg-bg-color relative overflow-hidden border border-surfaceBorder">
                        <div 
                            className="absolute top-0 left-0 h-full bg-accent transition-all duration-300"
                            style={{ width: `${uploadProgress}%` }}
                        ></div>
                    </div>
                    
                    <p className="text-gray-500 text-xs font-mono tracking-widest">
                        ANALYZING COMPOUNDS // {uploadProgress}% COMPLETE
                    </p>
                </div>
            )}
        </div>
      </section>

      {loading && !uploading && (
        <div className="flex-1 flex flex-col items-center justify-center animate-slide-up delay-200">
          <div className="w-16 h-16 border-4 border-surfaceBorder border-t-accent rounded-full animate-spin mb-4"></div>
          <p className="text-accent tracking-widest animate-pulse uppercase">Establishing uplink...</p>
        </div>
      )}

      {error && (
        <div className="bg-red-900/20 border border-red-500 p-6 animate-slide-up delay-200 relative overflow-hidden mb-8">
          <div className="absolute top-0 left-0 w-1 h-full bg-red-500"></div>
          <h2 className="display-font text-3xl text-red-500 mb-2">SYSTEM FAULT</h2>
          <p className="text-red-400 font-mono text-sm uppercase">{error}</p>
        </div>
      )}

      <main className="flex-1">
        {!loading && !error && meals.length === 0 && (
          <div className="h-64 border-2 border-dashed border-surfaceBorder flex flex-col items-center justify-center animate-slide-up delay-300 relative">
            <div className="absolute top-2 left-2 text-surfaceBorder text-xs">NO_DATA_FOUND</div>
            <div className="absolute bottom-2 right-2 text-surfaceBorder text-xs">AWAITING_INPUT</div>
            <p className="text-gray-500 uppercase tracking-widest text-sm max-w-md text-center">
              Datastore is empty. Upload a receipt or deploy iOS Shortcut.
            </p>
          </div>
        )}

        <div className="industrial-grid">
          {meals.map((meal, idx) => (
            <div 
              key={meal.receiptId} 
              className={`industrial-card p-6 animate-slide-up`}
              style={{ animationDelay: `${150 + (idx * 50)}ms` }}
            >
              <div className="flex justify-between items-start mb-6">
                <div>
                  <p className="text-xs text-accent font-bold tracking-widest mb-2 uppercase">
                    ENTRY // {meal.receiptId.split('/')[2]?.substring(0,6) || meal.receiptId.split('/')[1]?.substring(0,6) || meal.receiptId.substring(0,6)}
                  </p>
                  <p className="text-sm text-gray-400">
                    {new Date(meal.processedAt).toLocaleString('en-US', { hour12: false })}
                  </p>
                </div>
                <div className="text-right">
                  <span className="display-font text-6xl md:text-7xl leading-none text-white block">{meal.totalCalories}</span>
                  <span className="text-xs text-gray-500 uppercase font-bold tracking-widest block -mt-1">Kcal</span>
                </div>
              </div>
              
              <div className="mt-4 pt-4 border-t border-surfaceBorder">
                <p className="text-xs text-gray-500 uppercase tracking-widest mb-3">Detected Compounds</p>
                <div className="flex flex-wrap gap-2">
                  {meal.items && meal.items.map((item, i) => (
                    <span key={i} className="bg-surfaceBorder text-gray-300 px-3 py-1 text-xs uppercase tracking-wider font-bold">
                      {item}
                    </span>
                  ))}
                </div>
              </div>

              <div className="mt-4 pt-4 border-t border-surfaceBorder flex justify-between items-center">
                {[
                  { label: 'PRO', value: meal.macros?.protein ?? 0 },
                  { label: 'CRB', value: meal.macros?.carbs ?? 0 },
                  { label: 'FAT', value: meal.macros?.fats ?? 0 },
                ].map((macro) => (
                  <div key={macro.label} className="flex-1 text-center">
                    <p className="text-[10px] text-gray-600 uppercase tracking-[0.2em] mb-1">{macro.label}</p>
                    <p className="display-font text-2xl text-white">{macro.value}<span className="text-xs text-gray-500 ml-0.5">g</span></p>
                  </div>
                ))}
              </div>

              {/* Delete Button */}
              <button
                onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(meal.receiptId); }}
                className="absolute bottom-4 right-4 w-8 h-8 flex items-center justify-center text-gray-600 hover:text-red-500 hover:bg-red-500/10 transition-all z-20"
                title="Destroy Record"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                  <path strokeLinecap="square" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
              </button>

              {/* Confirmation Overlay */}
              {confirmDeleteId === meal.receiptId && (
                <div className="absolute inset-0 bg-black/90 z-30 flex flex-col items-center justify-center gap-6 p-6">
                  <div className="w-12 h-12 border-2 border-red-500 flex items-center justify-center">
                    <svg className="w-6 h-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                      <path strokeLinecap="square" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                  </div>
                  <p className="text-red-400 text-sm font-bold tracking-widest uppercase text-center">DESTROY RECORD?</p>
                  <p className="text-gray-500 text-xs tracking-wider uppercase text-center">This action is irreversible.</p>
                  <div className="flex gap-4">
                    <button
                      onClick={() => handleDelete(meal.receiptId)}
                      disabled={deletingId === meal.receiptId}
                      className="px-6 py-2 border border-red-500 text-red-400 text-xs uppercase tracking-widest font-bold hover:bg-red-500 hover:text-black transition-all disabled:opacity-50"
                    >
                      {deletingId === meal.receiptId ? 'PURGING...' : 'CONFIRM'}
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="px-6 py-2 border border-surfaceBorder text-gray-500 text-xs uppercase tracking-widest font-bold hover:border-gray-400 hover:text-gray-300 transition-all"
                    >
                      CANCEL
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] flex flex-col items-center justify-center">
      <Authenticator 
        loginMechanisms={['email']}
        hideSignUp={false}
      >
        <Dashboard />
      </Authenticator>
    </div>
  );
}