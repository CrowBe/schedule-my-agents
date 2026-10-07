import { requireChatGPTUser } from '../../chatgpt-auth';
import NativeFetchDiagnostic from './run';

export const dynamic = 'force-dynamic';
export default async function Page() {
 await requireChatGPTUser('/diagnostics/native-fetch');
 return <NativeFetchDiagnostic />;
}
