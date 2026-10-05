import { requireChatGPTUser } from './chatgpt-auth';
import Setup from './setup';
export const dynamic = 'force-dynamic';
export default async function Home() {
  await requireChatGPTUser('/');
  return <Setup />;
}
