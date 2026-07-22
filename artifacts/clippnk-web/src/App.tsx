import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@workspace/api-client-react';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { Shell } from '@/components/layout/Shell';
import Dashboard from '@/pages/dashboard';
import ClipView from '@/pages/clip-view';
import Admin from '@/pages/admin';
import Login from '@/pages/login';
import Blocked from '@/pages/blocked';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Don't waste a retry (and its backoff delay) on 4xx responses like the
      // 401 from /api/auth/me when logged out — those aren't transient, so
      // retrying just delays the UI from showing the logged-out state.
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          return false;
        }
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
      // Use 'always' instead of the default 'online' networkMode: some browser/proxy
      // environments report navigator.onLine incorrectly, which otherwise leaves
      // queries stuck in a permanent "paused" fetchStatus and the UI stuck loading.
      networkMode: 'always',
    },
    mutations: {
      networkMode: 'always',
    },
  },
});

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/blocked" component={Blocked} />
      <Route path="*">
        <Shell>
          <Switch>
            <Route path="/" component={Dashboard} />
            <Route path="/clips/:id" component={ClipView} />
            <Route path="/admin" component={Admin} />
            <Route component={NotFound} />
          </Switch>
        </Shell>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;