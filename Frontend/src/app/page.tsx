import { redirect } from 'next/navigation';

export default function Home() {
  // Automatically redirect anyone visiting the root URL to the login page
  redirect('/login');
}