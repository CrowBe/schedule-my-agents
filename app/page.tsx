import { requireChatGPTUser } from './chatgpt-auth';
import Setup from './setup';
export default async function Home() {
  await requireChatGPTUser('/');
  return <Setup />;
}
