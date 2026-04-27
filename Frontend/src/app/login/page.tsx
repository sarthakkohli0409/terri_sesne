"use client";

import React, { useState } from 'react';
import { Mail, Lock, Loader2, AlertCircle, ArrowRight, Map } from 'lucide-react';
// import { cn } from '@/lib/utils';  
import { mockUsers } from '@/data/mock-users'; 
export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

     await new Promise(resolve => setTimeout(resolve, 1000));

     const user = mockUsers.find(
      (u) => u.email === email && u.password === password
    );

    if (user) {
       console.log("Logged in successfully:", user);
      window.location.href = '/dashboard';  
    } else {
      setError("Invalid email or password. Please try again.");
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex bg-slate-50 text-slate-900 font-sans">
      
       <div className="hidden lg:flex lg:w-1/2 bg-slate-900 p-12 flex-col justify-between relative overflow-hidden text-white">
        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-12">
             <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center shadow-lg"> 
              <Map className="w-6 h-6 text-white" />
              
             </div>
            {/* <img src="\images\T_logo.png" alt="" className="w-60 h-auto text-white" /> */}
            <span className="text-2xl font-bold tracking-tight">Terrisense</span>
          </div>
          
          <h1 className="text-4xl font-semibold leading-tight mb-6">
            Intelligent Territory <br />
            <span className="text-blue-400">Optimization.</span>
          </h1>
          <p className="text-slate-400 text-lg max-w-md leading-relaxed">
            TerriSense is a next-generation platform designed to optimize territory alignment and omnichannel engagement for pharma organizations. It leverages advanced analytics, AI, and integrated data to deliver precision, agility, and fairness in territory design.
 
          </p>
        </div>

         <div className="absolute -bottom-24 -left-24 w-96 h-96 bg-blue-600/20 rounded-full blur-3xl z-0" />
        <div className="absolute top-1/4 -right-12 w-64 h-64 bg-emerald-500/10 rounded-full blur-3xl z-0" />

        <div className="relative z-10 text-sm text-slate-500">
          © {new Date().getFullYear()} Terrisense. All rights reserved.
        </div>
      </div>

       <div className="w-full lg:w-1/2 flex items-center justify-center p-8 sm:p-12">
        <div className="w-full max-w-md space-y-8 bg-white p-8 rounded-2xl shadow-sm border border-slate-200">
          
          <div className="text-center lg:text-left">
            <h2 className="text-2xl font-bold text-slate-900">Welcome back</h2>
            <p className="text-sm text-slate-500 mt-2">
              Please enter your details.
            </p>
          </div>

          <form onSubmit={handleLogin} className="space-y-6">
            
             <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-700">
                Email Address
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Mail className="h-5 w-5 text-slate-400" />
                </div>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="admin@terrisense.com"
                  className="block w-full pl-10 p-3 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all bg-slate-50 focus:bg-white"
                />
              </div>
            </div>

             <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="block text-sm font-medium text-slate-700">
                  Password
                </label>
                <a href="#" className="text-sm font-medium text-blue-600 hover:text-blue-500">
                  Forgot password?
                </a>
              </div>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Lock className="h-5 w-5 text-slate-400" />
                </div>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  placeholder="••••••••"
                  className="block w-full pl-10 p-3 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all bg-slate-50 focus:bg-white"
                />
              </div>
            </div>

             {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-2 animate-in fade-in slide-in-from-top-2">
                <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
                <p className="text-sm text-red-600 font-medium">{error}</p>
              </div>
            )}

             <button
              type="submit"
              disabled={loading}
              className="group w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white p-3 rounded-xl font-semibold shadow-md transition-all active:scale-[0.98]"
            >
              {loading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <>
                  Sign In
                  <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                </>
              )}
            </button>

          </form>

           <div className="mt-8 p-4 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-500 leading-relaxed text-center">
            <strong>Dev Note:</strong> Use <code className="bg-slate-200 px-1 rounded text-slate-700">admin@terrisense.com</code> and <code className="bg-slate-200 px-1 rounded text-slate-700">password123</code> to test the login.
          </div>

        </div>
      </div>

    </div>
  );
}