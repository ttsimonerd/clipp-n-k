import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getListClipsQueryKey, type Clip } from '@workspace/api-client-react';

interface UploadOptions {
  file: File;
  title?: string;
  onSuccess?: (clip: Clip) => void;
  onError?: (error: string) => void;
}

export function useClipUpload() {
  const [progress, setProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const upload = useCallback(
    ({ file, title, onSuccess, onError }: UploadOptions) => {
      setIsUploading(true);
      setProgress(0);
      setError(null);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${import.meta.env.BASE_URL}api/clips`);
      xhr.withCredentials = true;

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const percentComplete = Math.round((event.loaded / event.total) * 100);
          setProgress(percentComplete);
        }
      };

      xhr.onload = () => {
        setIsUploading(false);
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const clip: Clip = JSON.parse(xhr.responseText);
            // Invalidate the clip list to show the new clip
            queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
            onSuccess?.(clip);
          } catch (e) {
            const msg = 'Invalid response from server';
            setError(msg);
            onError?.(msg);
          }
        } else {
          let msg = 'Upload failed';
          try {
            const res = JSON.parse(xhr.responseText);
            if (res.error) msg = res.error;
          } catch (e) {
            // ignore
          }
          setError(msg);
          onError?.(msg);
        }
      };

      xhr.onerror = () => {
        setIsUploading(false);
        const msg = 'Network error during upload';
        setError(msg);
        onError?.(msg);
      };

      const formData = new FormData();
      formData.append('file', file);
      if (title) formData.append('title', title);

      xhr.send(formData);
    },
    [queryClient]
  );

  return { upload, progress, isUploading, error };
}