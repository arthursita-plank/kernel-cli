import { Kernel, type KernelContext } from '@onkernel/sdk';
import 'dotenv/config';
import { Agent } from './lib/agent';
import computers from './lib/computers';

interface Input {
  task?: string;
}

interface Output {
  elapsed: number;
  answer: string | null;
  download?: string | null;
  logs?: any[];
}

const kernel = new Kernel();
const app = kernel.app('ehr-system');

if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is not set');
}

const DEFAULT_TASK = `
Go to https://ehr-system-six.vercel.app/login
Login with any email and password (e.g. user@example.com / password).
Navigate to the "Reports" page.
Find the "Export CSV" button and click it to download the report.
Wait for the download to start.
CRITICAL: Do not ask for confirmation. Perform all steps immediately.
`;

app.action<Input, Output>(
  'export-report',
  async (ctx: KernelContext, payload?: Input): Promise<Output> => {
    const start = Date.now();
    const task = payload?.task || DEFAULT_TASK;

    const kb = await kernel.browsers.create({ 
      invocation_id: ctx.invocation_id,
      stealth: true 
    });
    console.log('> Kernel browser live view url:', kb.browser_live_view_url);

    try {
      const { computer } = await computers.create({ type: 'kernel', cdp_ws_url: kb.cdp_ws_url });

      const agent = new Agent({
        model: 'computer-use-preview', // Using a capable model for computer use
        computer,
        tools: [],
        acknowledge_safety_check_callback: (m: string): boolean => {
          console.log(`> safety check: ${m}`);
          return true;
        },
      });

      console.log('Starting download listener...');
      // Start listening for download before running the agent
      // Set a long timeout (5 minutes) because the agent might take time to navigate
      const downloadPromise = (computer as any).waitForDownload(300000);
      
      // run agent and get response
      const logs = await agent.runFullTurn({
        messages: [
          {
            role: 'system',
            content: `You are an automated agent. Current date and time: ${new Date().toISOString()}. You must complete the task fully without asking for permission.`,
          },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: task }],
          },
        ],
        print_steps: true,
        debug: true,
        show_images: false,
      });

      // Wait for download to resolve (it should have happened during the run)
      // We use a small timeout race just in case it's still pending but not happening
      const download = await Promise.race([
        downloadPromise,
        new Promise<null>(resolve => setTimeout(() => resolve(null), 5000))
      ]);

      if (download) {
        console.log(`Download captured: ${download}`);
      } else {
        console.log('No download captured within timeout.');
      }

      const elapsed = parseFloat(((Date.now() - start) / 1000).toFixed(2));

      // filter only LLM messages

      // filter only LLM messages
      const messages = logs.filter(
        (item: any) =>
          item.type === 'message' &&
          typeof item.role === 'string' &&
          Array.isArray(item.content),
      );
      const assistant = messages.find((m: any) => m.role === 'assistant') as any;
      const lastContentIndex = assistant?.content?.length ? assistant.content.length - 1 : -1;
      const lastContent = lastContentIndex >= 0 ? assistant?.content?.[lastContentIndex] : null;
      const answer = lastContent && 'text' in lastContent ? lastContent.text : null;

      return {
        elapsed,
        answer,
        download
      };
    } catch (error) {
      const elapsed = parseFloat(((Date.now() - start) / 1000).toFixed(2));
      console.error('Error in export-report:', error);
      return {
        elapsed,
        answer: null,
      };
    } finally {
      await kernel.browsers.deleteByID(kb.session_id);
    }
  },
);
